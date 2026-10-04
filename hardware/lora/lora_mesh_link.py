"""LoRa mesh link: joins two bitchat BLE-mesh areas over a pair of LoRa radios.

Bluetooth reaches tens of metres per hop. Two Unos with SX1278 radios (running
modem/modem.ino) carry the same IDX1 packets over hundreds of metres to
kilometres, so phones that cannot hear each other over Bluetooth still share
reports, SOS and the control room's alerts.

    phones (BLE) ── bitchat phone :8765 ── laptop A ── Uno+LoRa  ~~~~~~
                                                                       ~~~ LoRa
    phones (BLE) ── bitchat phone :8765 ── laptop B ── Uno+LoRa  ~~~~~~
                                               │
                                               └── internet ── Indradhanu API

Run one copy next to each Uno. Give it whatever that laptop has:

    --phone IP   a bitchat phone (fork with the VLM API on) on the same Wi-Fi
    --api URL --key KEY   internet + the API's MESH_GATEWAY_KEY

What it does with them:

    phone inbox  -> LoRa (and -> API when --api)
    LoRa         -> phone (into the BLE mesh) and -> API when --api
    API outbox   -> LoRa and -> phone          (alerts, dispatches to the offline area)
    keyboard     -> LoRa                       (type "sos <text>" or any text)

Only IDX1 packets are relayed by default (--all relays every mesh message).
Each message is sent twice over LoRa and de-duplicated everywhere by its
content, so nothing loops between the two sides.

    pip install pyserial

    # offline area, laptop A with a phone:
    python lora_mesh_link.py --phone 192.168.43.20 --name field-A --lat 18.5204 --lon 73.8567

    # command centre, laptop B with internet (phone optional):
    python lora_mesh_link.py --api https://disruptionops.onrender.com --key <MESH_GATEWAY_KEY> --name hq-B

    # no phones at all: on laptop A type   sos water entering the ground floor
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import queue
import random
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import OrderedDict

MAXPKT = 240
HDR = 8                        # b"M" + 4-char id + idx + total + b":"
CHUNK = MAXPKT - HDR
B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def log(tag: str, msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} [{tag}] {msg}", flush=True)


# ------------------------------------------------------------------ framing ---
def fragments(data: bytes) -> list[bytes]:
    """Split one message into LoRa frames: b'M' + id(4) + idx + total + b':' + chunk."""
    mid = uuid.uuid4().hex[:4].encode()
    parts = [data[i:i + CHUNK] for i in range(0, len(data), CHUNK)] or [b""]
    if len(parts) >= len(B36):
        raise ValueError("message too long for the link")
    return [b"M" + mid + B36[i].encode() + B36[len(parts)].encode() + b":" + p for i, p in enumerate(parts)]


class Reassembler:
    def __init__(self, ttl: float = 90.0):
        self.ttl = ttl
        self.parts: dict[bytes, dict] = {}

    def add(self, frame: bytes) -> bytes | None:
        now = time.monotonic()
        for k in [k for k, v in self.parts.items() if now - v["t"] > self.ttl]:
            del self.parts[k]
        if len(frame) < HDR or frame[:1] != b"M" or frame[7:8] != b":":
            return None
        mid, idx, total = frame[1:5], B36.find(chr(frame[5])), B36.find(chr(frame[6]))
        if idx < 0 or total <= 0 or idx >= total:
            return None
        e = self.parts.setdefault(mid, {"t": now, "n": total, "got": {}})
        e["got"][idx] = frame[HDR:]
        if len(e["got"]) == e["n"]:
            del self.parts[mid]
            return b"".join(e["got"][i] for i in range(e["n"]))
        return None


class Seen:
    """Content de-duplication across all paths (LoRa, phone, API)."""

    def __init__(self, keep: int = 2000):
        self.keep, self.d = keep, OrderedDict()
        self.lock = threading.Lock()

    @staticmethod
    def key(text: str) -> str:
        t = text.strip()
        i = t.find("IDX1|")
        return hashlib.sha1((t[i:] if i >= 0 else t).encode()).hexdigest()

    def first(self, text: str) -> bool:
        k = self.key(text)
        with self.lock:
            if k in self.d:
                return False
            self.d[k] = True
            while len(self.d) > self.keep:
                self.d.popitem(last=False)
            return True


# -------------------------------------------------------------------- modem ---
class Modem:
    def __init__(self, port: str | None, baud: int = 115200):
        import serial
        from serial.tools import list_ports
        if not port:
            ports = list(list_ports.comports())
            cands = [p.device for p in ports if any(k in f"{p.description} {p.manufacturer} {p.hwid}".lower()
                                                    for k in ("arduino", "ch34", "wch", "usb-serial", "2341:", "1a86:"))]
            port = (cands or [p.device for p in ports] or [None])[0]
        if not port:
            sys.exit("[link] no Arduino found. Plug it in, close the Arduino Serial Monitor, or pass --port COM5")
        self.port = port
        self.ser = serial.Serial(port, baud, timeout=0.2)
        self.resp: queue.Queue[str] = queue.Queue()
        self.frames: queue.Queue[tuple[int, float, bytes]] = queue.Queue()
        self.tx_lock = threading.Lock()
        self.ready = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()
        time.sleep(2.2)                       # the Uno resets when the port opens
        if not self.ready.wait(4):
            self.ping()

    def _read(self) -> None:
        buf = b""
        while True:
            try:
                buf += self.ser.read(512)
            except Exception as e:  # unplugged
                log("modem", f"serial error: {e}")
                time.sleep(1)
                continue
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("ascii", "replace").strip()
                if not line:
                    continue
                if line.startswith("R"):
                    try:
                        rssi, snr, hx = line[1:].split(",", 2)
                        self.frames.put((int(rssi), float(snr), bytes.fromhex(hx)))
                    except ValueError:
                        log("modem", f"garbled line: {line[:60]}")
                elif line.startswith("READY"):
                    self.ready.set()
                    log("modem", f"{self.port}: {line}")
                elif line.startswith("!radio"):
                    log("modem", line)
                else:
                    self.resp.put(line)

    def _cmd(self, cmd: str, expect: str, timeout: float = 2.0) -> str:
        while not self.resp.empty():
            self.resp.get_nowait()
        self.ser.write((cmd + "\n").encode())
        try:
            r = self.resp.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"no answer to {cmd[:1]}")
        if not r.startswith(expect):
            raise RuntimeError(f"modem said {r!r} to {cmd[:1]}")
        return r

    def ping(self) -> str:
        with self.tx_lock:
            r = self._cmd("P", "P")
            self.ready.set()
            return r

    def send_frame(self, frame: bytes) -> None:
        with self.tx_lock:
            self._cmd("C", "+")
            for i in range(0, len(frame), 24):
                self._cmd("A" + frame[i:i + 24].hex(), "+")
            self._cmd("S", "D", timeout=6)


# --------------------------------------------------------------------- HTTP ---
def http(method: str, url: str, body: dict | None = None, headers: dict | None = None,
         timeout: float = 10.0) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "indradhanu-lora-link/1")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def idx1(type_: str, body: dict, key: str = "", human: str = "") -> str:
    """Same format as backend/app/mesh/envelope.py and scripts/mesh_bridge.py."""
    clean = {k: (round(v, 5) if k in ("la", "lo") else v) for k, v in body.items() if v not in (None, "")}
    payload = json.dumps(clean, separators=(",", ":"), ensure_ascii=False)
    sig = hmac.new(key.encode(), f"IDX1|{type_}|{payload}".encode(), hashlib.sha256).hexdigest()[:16] if key else "-"
    text = f"IDX1|{type_}|{payload}|{sig}"
    return f"{human.strip()} {text}" if human else text


# --------------------------------------------------------------------- link ---
class Link:
    def __init__(self, a: argparse.Namespace, modem):
        self.a, self.modem = a, modem
        self.seen = Seen()
        self.reasm = Reassembler()
        self.lora_q: queue.Queue[str] = queue.Queue()
        self.phone_q: queue.Queue[str] = queue.Queue()
        self.phone = f"http://{a.phone}:{a.phone_port}" if a.phone else None
        self.api = a.api.rstrip("/") + ("" if a.api.rstrip("/").endswith("/api/v1") else "/api/v1") if a.api else None
        self.gw = {"X-Mesh-Gateway-Key": a.key}
        self.stats = {"lora_in": 0, "lora_out": 0, "phone_in": 0, "phone_out": 0, "api_in": 0, "api_out": 0}

    def relay_ok(self, text: str) -> bool:
        return self.a.all or "IDX1|" in text

    # ---- outputs
    def to_lora(self, text: str) -> None:
        self.lora_q.put(text)

    def to_phone(self, text: str) -> None:
        if self.phone:
            self.phone_q.put(text)

    def to_api(self, texts: list[str]) -> None:
        if not self.api:
            return
        texts = [t for t in texts if "IDX1|" in t]
        if not texts:
            return
        c, res = http("POST", f"{self.api}/mesh/inbound", {"gatewayId": self.a.name, "packets": texts}, self.gw)
        if c == 200:
            self.stats["api_out"] += len(texts)
            for t, r in zip(texts, res.get("results", [])):
                log("api", f"{r.get('outcome') or r.get('error') or r}: {t[-80:]}")
        else:
            log("api", f"refused ({c}): {str(res)[:160]}")

    # ---- workers
    def lora_tx(self) -> None:
        while True:
            text = self.lora_q.get()
            frames = fragments(text.encode("utf-8"))
            for rep in range(self.a.repeat):
                if rep:
                    time.sleep(random.uniform(1.2, 2.8))
                for f in frames:
                    try:
                        self.modem.send_frame(f)
                    except Exception as e:
                        log("lora", f"send failed: {e}")
                        time.sleep(1)
                    time.sleep(0.15)
            self.stats["lora_out"] += 1
            log("lora>", f"{len(frames)} frame(s): {text[:100]}")

    def lora_rx(self) -> None:
        while True:
            rssi, snr, frame = self.modem.frames.get()
            data = self.reasm.add(frame)
            if data is None:
                continue
            text = data.decode("utf-8", "replace")
            if not self.seen.first(text):
                continue
            self.stats["lora_in"] += 1
            log("<lora", f"rssi {rssi} snr {snr}: {text[:120]}")
            self.to_phone(text)
            self.to_api([text])

    def phone_tx(self) -> None:
        last = 0.0
        while True:
            text = self.phone_q.get()
            while True:
                wait = self.a.rate - (time.monotonic() - last)
                if wait > 0:
                    time.sleep(wait)
                body = {"text": text}
                if self.a.channel:
                    body["channel"] = self.a.channel
                c, r = http("POST", f"{self.phone}/send/text", body)
                last = time.monotonic()
                if c == 200:
                    self.stats["phone_out"] += 1
                    log("phone>", text[:100])
                    break
                log("phone", f"send refused ({c}): {r.get('error') or r}; retrying")
                time.sleep(2)

    def phone_rx(self) -> None:
        since = 0
        c, st = http("GET", f"{self.phone}/status")
        log("phone", f"{self.phone}: {c} {str(st)[:120]}")
        if c == 200 and not st.get("api_enabled", True):
            log("phone", "turn on Settings → VLM API in bitchat")
        while True:
            c, box = http("GET", f"{self.phone}/inbox?since={since}")
            if c == 200:
                msgs = [m.get("text", "") for m in box.get("messages", [])]
                since = box.get("next", since)
                fresh = [t for t in msgs if t and self.relay_ok(t) and self.seen.first(t)]
                for t in fresh:
                    self.stats["phone_in"] += 1
                    log("<phone", t[:120])
                    self.to_lora(t)
                self.to_api(fresh)
            elif c == 0:
                log("phone", f"unreachable: {box.get('error')}")
                time.sleep(5)
            time.sleep(self.a.every)

    def api_rx(self) -> None:
        while True:
            c, out = http("GET", f"{self.api}/mesh/outbox?gateway_id={self.a.name}&limit=10", headers=self.gw)
            if c == 200:
                ids = []
                for m in out.get("messages", []):
                    text = m.get("text", "")
                    ids.append(m["id"])
                    if text and self.seen.first(text):
                        self.stats["api_in"] += 1
                        log("<api", f"{m.get('kind')}: {text[:100]}")
                        self.to_lora(text)
                        self.to_phone(text)
                if ids:
                    http("POST", f"{self.api}/mesh/outbox/ack", {"gatewayId": self.a.name, "ids": ids}, self.gw)
            elif c in (401, 403):
                log("api", f"key refused ({c}); outbox polling paused 60 s")
                time.sleep(60)
            time.sleep(self.a.every * 2)

    def keyboard(self) -> None:
        print("Type a message and Enter to send it over LoRa. 'sos <text>' sends a located report. 'stats' shows counters.")
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            if line == "stats":
                print(self.stats)
                continue
            if line.lower().startswith("sos ") or line.lower().startswith("report "):
                note = line.split(" ", 1)[1]
                if self.a.lat is None or self.a.lon is None:
                    print("start with --lat and --lon to send located reports")
                    continue
                text = idx1("R", {"id": f"lora-{uuid.uuid4().hex[:10]}", "n": self.a.name, "la": self.a.lat,
                                  "lo": self.a.lon, "x": note[:200], "t": int(time.time())},
                            self.a.hmac, human=f"[SOS] {note[:80]}")
            else:
                text = line
            self.seen.first(text)
            self.to_lora(text)
            self.to_phone(text)
            self.to_api([text])

    def run(self) -> None:
        jobs = [self.lora_tx, self.lora_rx]
        if self.phone:
            jobs += [self.phone_tx, self.phone_rx]
        if self.api:
            jobs.append(self.api_rx)
        for j in jobs:
            threading.Thread(target=j, daemon=True).start()
        log("link", f"{self.a.name}: LoRa on {getattr(self.modem, 'port', '?')}"
                    f"{' · phone ' + self.phone if self.phone else ''}{' · API ' + self.api if self.api else ''}")
        if sys.stdin and sys.stdin.isatty() or self.a.keyboard:
            threading.Thread(target=self.keyboard, daemon=True).start()
        try:
            while True:
                time.sleep(60)
                log("stats", str(self.stats))
        except KeyboardInterrupt:
            print()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="COM5 / /dev/ttyUSB0 (auto-detected if omitted)")
    ap.add_argument("--name", default=f"lora-{uuid.getnode() % 10000}", help="this end's name (shows on the console)")
    ap.add_argument("--phone", default=os.getenv("BITCHAT_IP"), help="bitchat phone IP on this Wi-Fi")
    ap.add_argument("--phone-port", type=int, default=8765)
    ap.add_argument("--channel", default=None, help="bitchat channel to post into (default: the phone's)")
    ap.add_argument("--api", default=os.getenv("INDRADHANU_API"), help="e.g. https://disruptionops.onrender.com")
    ap.add_argument("--key", default=os.getenv("MESH_GATEWAY_KEY", ""), help="the API's MESH_GATEWAY_KEY")
    ap.add_argument("--hmac", default=os.getenv("MESH_HMAC_KEY", ""), help="MESH_HMAC_KEY, to sign 'sos' reports typed here")
    ap.add_argument("--lat", type=float, default=None, help="where this end is, for 'sos' reports")
    ap.add_argument("--lon", type=float, default=None)
    ap.add_argument("--all", action="store_true", help="relay every mesh message, not only IDX1 packets")
    ap.add_argument("--repeat", type=int, default=2, help="send each message this many times over LoRa")
    ap.add_argument("--every", type=float, default=3.0, help="seconds between phone polls")
    ap.add_argument("--rate", type=float, default=5.5, help="seconds between sends to the phone (bitchat limit)")
    ap.add_argument("--keyboard", action="store_true", help="read messages from stdin even when not a terminal")
    a = ap.parse_args()
    if a.api and not a.key:
        ap.error("--api needs --key (MESH_GATEWAY_KEY)")
    Link(a, Modem(a.port)).run()


if __name__ == "__main__":
    main()
