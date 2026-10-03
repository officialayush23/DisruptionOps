"""The control room's side of the offline mesh.

Inbound: a gateway (a phone with signal, or `scripts/mesh_bridge.py` on a
laptop beside one) posts the IDX1 packets it heard. Each is verified, stored
once however many gateways relay it, and turned into what it describes:

    R  -> intake.receive(source='mesh')      same door as the app
    S  -> intake.receive(source='sensor')    camera / sensor detections
    F  -> road block / task status           a crew's report
    H  -> mesh_nodes                          who is alive, and where
    K  -> mesh_outbox acked                   delivery confirmation

Outbound: nothing in the planner, the gate or the executor knows the mesh
exists, and nothing needs to. The event log already records every alert,
dispatch, cancellation, re-route and road block, so `sync_outbox` reads new
events from a cursor and turns the ones a person offline needs into packets.
Gateways pull `/mesh/outbox`, broadcast, and ack.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger
from app.db import session as db
from app.incidents import intake
from app.mesh import envelope
from app.taxonomy import cache as taxonomy
from app.world import clock as clocks
from app.world import events as ev

log = get_logger(__name__)

#: Detector names from ai-surveillance -> incident categories. Detectors that are
#: not a hazard (phone use, smoking, identity) are not in this table and are
#: refused: they have no business in a disaster system.
SENSOR_CATEGORY = {
    "fire": "fire",
    "smoke": "fire",
    "fall": "unknown_report",       # a person down: needs eyes, not a guess
    "fight": "unknown_report",
    "violence": "unknown_report",
    "gathering": "unknown_report",
    "object_left": "unknown_report",
    "water_level": "waterlogging",
    "flood": "flooded_road",
    # Classes the VLM names from a scene description (see the phone's
    # SyncBundleBuilder.hazardKind and the camera's indradhanu_bridge.scene_kind).
    "collapse": "unknown_report",
    "medical": "unknown_report",
    "assault": "unknown_report",
}

OUTBOUND_KINDS = (
    "alert.issued", "assignment.created", "assignment.changed",
    "assignment.cancelled", "assignment.rerouted", "road.blocked",
)


# ----------------------------------------------------------------- helpers ---
def _json(v: Any) -> Any:
    """asyncpg hands jsonb back as text unless a codec is set; accept both."""
    if isinstance(v, (str, bytes)):
        try:
            return json.loads(v)
        except ValueError:
            return {}
    return v if v is not None else {}


async def ward_at(lng: float, lat: float, city_id: str = "pune") -> str | None:
    return await db.fetchval(
        """
        select id from wards
         where city_id = $1
         order by extensions.ST_Covers(
                    boundary,
                    extensions.ST_SetSRID(extensions.ST_MakePoint($2,$3),4326)::extensions.geography
                  ) desc,
                  extensions.ST_Distance(
                    centroid,
                    extensions.ST_SetSRID(extensions.ST_MakePoint($2,$3),4326)::extensions.geography)
         limit 1
        """,
        city_id, lng, lat,
    )


def _when(t: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(t), tz=UTC)
    except (TypeError, ValueError, OSError):
        return None


def _category(kind: str) -> str:
    kind = (kind or "").strip().lower()
    if kind in taxonomy.categories:
        return kind
    return "unknown_report"


# ------------------------------------------------------ bitchat civ sync ---
#: The bitchat fork's "return to civilization" bundle (`bitchat.civ.sync/v1`):
#: when a phone that heard the mesh gets internet it posts everything it holds,
#: incidents (SOS, geotagged broadcasts, VLM camera briefs) and shelters. Each
#: incident becomes an ordinary R packet so it takes exactly the same path as a
#: report typed into the web app's mesh mode: same dedupe, same trust, same
#: intake. Nothing here decides what a report means.
CIV_SCHEMA = "bitchat.civ.sync/v1"


def civ_incident_packet(inc: dict[str, Any], *, key: str) -> str | None:
    """One bundle incident as an IDX1 R packet, or None if it cannot be one."""
    raw_id = str(inc.get("id") or "").strip()
    if not raw_id:
        return None
    try:
        lat = float(inc["lat"])
        lon = float(inc["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None
    ts = inc.get("timestamp")
    try:
        t = int(int(ts) / 1000) if ts and int(ts) > 10**11 else int(ts or 0) or None
    except (TypeError, ValueError):
        t = None
    text = str(inc.get("content") or "").strip()
    role = str(inc.get("role") or "UNSET").upper()
    source = str(inc.get("source") or "").lower()
    kind = str(inc.get("kind") or "").lower()
    if source == "vlm" and kind in SENSOR_CATEGORY:
        body = {"id": "b" + raw_id[:30], "n": str(inc.get("sender") or "camera")[:40],
                "k": kind, "c": float(inc.get("confidence") or 0.7), "v": 1,
                "la": round(lat, 5), "lo": round(lon, 5), "x": text[:280], "t": t}
        return envelope.encode("S", body, key=key)
    body = {"id": "b" + raw_id[:30], "n": str(inc.get("sender") or "mesh")[:40],
            "la": round(lat, 5), "lo": round(lon, 5), "x": text[:280], "t": t}
    if role not in ("", "UNSET", "CIVILIAN"):
        body["x"] = f"[{role.lower()}] " + body["x"]
    return envelope.encode("R", body, key=key)


async def receive_civ_bundle(bundle: dict[str, Any], *, gateway_id: str,
                             city_id: str = "pune") -> dict:
    incidents = bundle.get("incidents") or []
    shelters = bundle.get("shelters") or []
    packets, skipped = [], 0
    for inc in incidents[:200]:
        text = civ_incident_packet(inc, key=settings.mesh_hmac_key)
        if text is None:
            skipped += 1
        else:
            packets.append(text)
    results = []
    for i in range(0, len(packets), 100):
        results += await receive(packets[i:i + 100], gateway_id=gateway_id, city_id=city_id)
    outcomes: dict[str, int] = {}
    for r in results:
        key = r.get("outcome") or ("error" if not r.get("ok") else "ok")
        outcomes[key] = outcomes.get(key, 0) + 1
    log.info("civ_bundle", gateway=gateway_id, incidents=len(incidents),
             shelters=len(shelters), skipped=skipped, outcomes=outcomes)
    return {"ok": True, "incidents": len(incidents), "accepted": len(packets),
            "skipped": skipped, "shelters": len(shelters), "outcomes": outcomes}


# ----------------------------------------------------------------- inbound ---
async def receive(texts: list[str], *, gateway_id: str, city_id: str = "pune") -> list[dict]:
    """Handle what a gateway heard. One result per text, in order."""
    out = []
    for text in texts[:100]:
        try:
            out.append(await _one(text, gateway_id=gateway_id, city_id=city_id))
        except Exception as exc:  # noqa: BLE001 - one bad packet must not drop the batch
            log.warning("mesh_packet_failed", error=str(exc)[:200])
            out.append({"ok": False, "error": type(exc).__name__})
    return out


async def _one(text: str, *, gateway_id: str, city_id: str) -> dict:
    try:
        pkt = envelope.decode(text, key=settings.mesh_hmac_key)
    except envelope.BadPacket as exc:
        return {"ok": False, "error": str(exc)}
    if pkt.type in envelope.OUTBOUND:
        # Our own broadcast heard back by a gateway. Not news.
        return {"ok": True, "outcome": "echo", "id": pkt.id}
    if not pkt.id:
        return {"ok": False, "error": "packet has no id"}

    inserted = await db.fetchval(
        """
        insert into mesh_messages
          (packet_id, type, node_id, gateway_id, hops, body, signed, verified, occurred_at)
        values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
        on conflict (packet_id, type) do nothing
        returning id
        """,
        pkt.id, pkt.type, str(pkt.body.get("n") or "")[:80] or None, gateway_id[:80],
        pkt.body.get("h"), json.dumps(pkt.body), pkt.signed, pkt.verified,
        _when(pkt.body.get("t")),
    )
    if inserted is None:
        return {"ok": True, "outcome": "duplicate", "id": pkt.id}

    handler = {"R": _report, "S": _sensor, "F": _field, "H": _heartbeat, "K": _ack}[pkt.type]
    outcome, ref = await handler(pkt, city_id=city_id)
    await db.execute(
        "update mesh_messages set outcome = $2, outcome_ref = $3 where id = $1",
        inserted, outcome, ref,
    )
    await _touch_node(pkt, gateway_id)
    return {"ok": True, "outcome": outcome, "ref": ref, "id": pkt.id,
            "verified": pkt.verified}


async def _touch_node(pkt: envelope.Packet, gateway_id: str) -> None:
    node = str(pkt.body.get("n") or "")[:80]
    loc = pkt.location
    for nid, kind in ((node, "camera" if pkt.type == "S" else "phone"),
                      (gateway_id[:80], "gateway")):
        if not nid:
            continue
        await db.execute(
            """
            insert into mesh_nodes (id, kind, lat, lon, last_seen)
            values ($1, $2, $3, $4, now())
            on conflict (id) do update
               set last_seen = now(),
                   lat = coalesce(excluded.lat, mesh_nodes.lat),
                   lon = coalesce(excluded.lon, mesh_nodes.lon)
            """,
            nid, kind,
            loc[1] if (loc and nid == node) else None,
            loc[0] if (loc and nid == node) else None,
        )


async def _intake(pkt: envelope.Packet, *, category: str, note: str, source: str,
                  city_id: str, sensor: bool = False) -> tuple[str, str | None]:
    loc = pkt.location
    if loc is None:
        return "refused", "no location"
    ward_id = await ward_at(loc[0], loc[1], city_id)
    if ward_id is None:
        return "refused", "outside every ward"
    node = str(pkt.body.get("n") or "unknown")[:60]
    # Camera detections are keyed `device:sensor:` whether or not they were signed:
    # citizen and crew views hide incidents only cameras have reported (see
    # `api/v1/personas.CAMERA_ONLY`), which needs to tell them apart from people.
    result = await intake.receive(
        ward_id=ward_id, category=category, location=loc, note=note[:500],
        source=source,
        reporter_key=f"device:sensor:{node}" if sensor else f"device:mesh:{node}",
        reporter_name=(f"Sensor {node}" if sensor
                       else "Via mesh" if source.startswith("mesh") else f"Sensor {node}"),
        device_id=f"mesh:{node}", occurred_at=_when(pkt.body.get("t")),
        city_id=city_id, clock=clocks.WALL,
    )
    if result.created_incident or result.linked:
        _nudge_planner("report over the mesh")
    outcome = ("report" if result.created_incident
               else "linked" if result.linked else "held")
    return outcome, result.incident_id or result.report_id


async def _report(pkt: envelope.Packet, *, city_id: str) -> tuple[str, str | None]:
    b = pkt.body
    category = _category(str(b.get("k") or ""))
    if category == "unknown_report" and b.get("x"):
        # The phone sent words, not a category: read them the way the app's
        # own report endpoint does (keywords first, model if confident).
        from app.incidents import parse

        try:
            category = (await parse.parse_with_model(str(b["x"]))).category or category
        except Exception:  # noqa: BLE001 - an unread report is still a report
            pass
    return await _intake(
        pkt, category=category,
        note=str(b.get("x") or "Reported over the offline mesh."),
        source="mesh" if pkt.verified else "mesh_unsigned", city_id=city_id,
    )


async def _sensor(pkt: envelope.Packet, *, city_id: str) -> tuple[str, str | None]:
    b = pkt.body
    kind = str(b.get("k") or "").lower()
    category = SENSOR_CATEGORY.get(kind)
    if category is None:
        return "refused", f"detector {kind!r} is not a hazard"
    try:
        conf = float(b.get("c") or 0)
    except (TypeError, ValueError):
        conf = 0.0
    vlm = " A vision model agreed." if b.get("v") else ""
    caption = f" Camera saw: {b['x']}." if b.get("x") else ""
    note = (f"Camera {b.get('n') or 'node'} detected {kind.replace('_', ' ')} "
            f"at {conf:.0%} confidence ({b.get('f') or 'single frame'}).{vlm}{caption}")
    # Unsigned sensor packets are treated as a person's unverified report.
    source = "sensor" if pkt.verified or not settings.mesh_hmac_key else "mesh_unsigned"
    outcome, ref = await _intake(pkt, category=category, note=note, source=source,
                                 city_id=city_id, sensor=True)
    if outcome in ("report", "linked") and conf >= 0.6:
        from app.agents import commander

        commander.nudge("sensor.escalation", note, key=f"sensor:{b.get('n')}",
                        incidentId=ref, node=b.get("n"))
    return outcome, ref


async def _field(pkt: envelope.Packet, *, city_id: str) -> tuple[str, str | None]:
    b = pkt.body
    kind = str(b.get("k") or "")
    unit = str(b.get("u") or "")[:40]
    loc = pkt.location
    if kind == "route_blocked" and loc:
        async with db.transaction() as conn:
            block_id = await conn.fetchval(
                """
                insert into road_blocks (city_id, location, reason, reported_by)
                values ($1, extensions.ST_SetSRID(
                          extensions.ST_MakePoint($2,$3),4326)::extensions.geography,
                        $4, $5)
                returning id::text
                """,
                city_id, loc[0], loc[1], str(b.get("x") or "Reported over the mesh")[:300],
                unit or "mesh",
            )
            await ev.append(
                clock=clocks.WALL, kind=ev.Kind.ROAD_BLOCKED, actor="field:mesh",
                subject_type="road_block", subject_id=block_id, city_id=city_id,
                payload={"reason": b.get("x"), "resource_id": unit, "via": "mesh"},
                conn=conn,
            )
        _nudge_planner("road blocked, reported over the mesh")
        return "road_block", block_id
    if kind in ("on_site", "accepted", "complete") and unit:
        await db.execute(
            """
            update field_tasks set status = $2::task_status,
                   accepted_at = coalesce(accepted_at, now()),
                   proof_note = coalesce(proof_note, $3)
             where resource_id = $1 and status::text in ('queued','accepted','on_site')
               and ($2 <> 'complete' or $3 is not null)
            """,
            unit, kind, (str(b.get("x")) if b.get("x") else None),
        )
        return "task_status", unit
    return "noted", None


async def _heartbeat(pkt: envelope.Packet, *, city_id: str) -> tuple[str, str | None]:
    return "heartbeat", str(pkt.body.get("n") or "")


async def _ack(pkt: envelope.Packet, *, city_id: str) -> tuple[str, str | None]:
    ref = str(pkt.body.get("i") or "")
    if ref.startswith("o") and ref[1:].isdigit():
        await db.execute(
            "update mesh_outbox set status = 'acked', acked_at = now() where id = $1",
            int(ref[1:]),
        )
    return "ack", ref


def _nudge_planner(trigger: str) -> None:
    from app.ops.operations import _replan_soon

    _replan_soon(trigger)


# ---------------------------------------------------------------- outbound ---
async def sync_outbox(city_id: str = "pune", batch: int = 200) -> int:
    """Turn new events into mesh messages. Idempotent: one row per event."""
    cursor = await db.fetchval(
        "select (value ->> 'event_id')::bigint from mesh_state where key = 'outbox_cursor'"
    )
    if cursor is None:
        # First run: start from now, not from the dawn of the log.
        cursor = await db.fetchval("select coalesce(max(id), 0) from events") or 0
        await db.execute(
            """
            insert into mesh_state (key, value) values ('outbox_cursor', $1::jsonb)
            on conflict (key) do nothing
            """,
            json.dumps({"event_id": cursor}),
        )
        return 0
    rows = await db.fetch(
        """
        select id, kind, subject_type, subject_id, ward_id, payload
          from events
         where id > $1 and kind = any($2::text[]) and sim_run_id is null
         order by id limit $3
        """,
        cursor, list(OUTBOUND_KINDS), batch,
    )
    last = await db.fetchval(
        "select coalesce(max(id), $1) from (select id from events where id > $1 order by id limit $2) e",
        cursor, batch,
    )
    made = 0
    for r in rows:
        try:
            msg = await _message_for(r)
        except Exception as exc:  # noqa: BLE001
            log.warning("mesh_outbound_skip", event=r["id"], error=str(exc)[:160])
            msg = None
        if msg is None:
            continue
        await db.execute(
            """
            insert into mesh_outbox
              (city_id, kind, text, body, ward_id, lat, lon, radius_m, priority,
               channel, source_event_id)
            values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
            on conflict (source_event_id) do nothing
            """,
            city_id, msg["kind"], msg["text"], json.dumps(msg["body"]),
            msg.get("ward_id"), msg.get("lat"), msg.get("lon"), msg.get("radius_m"),
            msg.get("priority", 3), msg.get("channel", "#indradhanu"), r["id"],
        )
        made += 1
    await db.execute(
        "update mesh_state set value = $1::jsonb where key = 'outbox_cursor'",
        json.dumps({"event_id": int(last or cursor)}),
    )
    return made


async def _message_for(r: Any) -> dict | None:
    p = r["payload"] if isinstance(r["payload"], dict) else json.loads(r["payload"] or "{}")
    kind = r["kind"]
    key = settings.mesh_hmac_key
    eid = r["id"]

    if kind == "alert.issued":
        a = await db.fetchrow(
            """
            select a.headline, a.action, a.severity, a.ward_id, w.name ward,
                   extensions.ST_X(w.centroid::extensions.geometry) lng,
                   extensions.ST_Y(w.centroid::extensions.geometry) lat
              from alerts a join wards w on w.id = a.ward_id
             where a.id = $1::uuid
            """,
            r["subject_id"],
        )
        if a is None:
            return None
        body = {"id": f"e{eid}", "w": a["ward_id"], "la": a["lat"], "lo": a["lng"],
                "r": 2500, "s": a["severity"], "x": (a["action"] or "")[:160]}
        human = f"ALERT {a['ward']}: {a['headline']}"
        return {"kind": "A", "text": envelope.encode("A", body, key=key, human=human),
                "body": body, "ward_id": a["ward_id"], "lat": a["lat"], "lon": a["lng"],
                "radius_m": 2500, "priority": 5 if (a["severity"] or 0) >= 4 else 4}

    if kind == "road.blocked":
        b = await db.fetchrow(
            """
            select extensions.ST_X(location::extensions.geometry) lng,
                   extensions.ST_Y(location::extensions.geometry) lat, reason
              from road_blocks where id = $1::uuid
            """,
            r["subject_id"],
        )
        if b is None:
            return None
        body = {"id": f"e{eid}", "la": b["lat"], "lo": b["lng"], "r": 150,
                "x": (b["reason"] or "")[:120]}
        return {"kind": "B",
                "text": envelope.encode("B", body, key=key,
                                        human=f"ROAD CLOSED: {b['reason'] or 'blocked'}"),
                "body": body, "ward_id": r["ward_id"], "lat": b["lat"], "lon": b["lng"],
                "radius_m": 150, "priority": 4}

    # Crew messages: dispatch, re-route, cancel.
    unit_id = p.get("resource_id") or (r["subject_id"] if r["subject_type"] == "resource" else None)
    if not unit_id:
        return None
    unit = await db.fetchrow("select id, label from resources where id = $1", unit_id)
    if unit is None:
        return None
    job = await db.fetchrow(
        """
        select a.eta_minutes, i.title, i.id::text incident_id,
               extensions.ST_X(coalesce(i.location, r.location)::extensions.geometry) lng,
               extensions.ST_Y(coalesce(i.location, r.location)::extensions.geometry) lat
          from resources r
          left join lateral (
            select * from assignments x where x.resource_id = r.id
             order by x.created_at desc limit 1) a on true
          left join incidents i on i.id = a.incident_id
         where r.id = $1
        """,
        unit_id,
    )
    title = (job["title"] if job else None) or p.get("incident_title") or p.get("purpose") or "new task"
    if kind == "assignment.cancelled":
        instead = (p.get("instead") or {}).get("kind") or "replan"
        body = {"id": f"e{eid}", "u": unit_id, "x": (p.get("reason") or "")[:120],
                "k": instead}
        human = f"CANCEL {unit['label']}: stop {p.get('incident_title') or 'current job'}"
        mk = "C"
    else:
        eta = p.get("eta_minutes") or (job["eta_minutes"] if job else None)
        body = {"id": f"e{eid}", "u": unit_id, "i": (job["incident_id"] or "")[:8] if job else "",
                "la": job["lat"] if job else None, "lo": job["lng"] if job else None,
                "m": eta, "x": title[:100]}
        verb = "NEW ROUTE" if kind == "assignment.rerouted" else "DISPATCH"
        human = f"{verb} {unit['label']}: {title[:60]}" + (f", {eta} min" if eta else "")
        mk = "D"
    return {"kind": mk, "text": envelope.encode(mk, body, key=key, human=human),
            "body": body, "lat": body.get("la"), "lon": body.get("lo"),
            "channel": "#field", "priority": 4}


async def pull(*, gateway_id: str, limit: int = 20, city_id: str = "pune") -> list[dict]:
    """What a gateway should broadcast next: highest priority, oldest first.

    A message is re-offered every 30 s until acked or it expires, because a
    gateway that pulled it may have lost signal before it sent it.
    """
    await sync_outbox(city_id)
    await db.execute(
        "update mesh_outbox set status = 'expired' where status in ('pending','sent') "
        "and expires_at < now()"
    )
    rows = await db.fetch(
        """
        update mesh_outbox o
           set status = 'sent', sent_at = now(), sent_by = $2, attempts = attempts + 1
          from (
            select id from mesh_outbox
             where city_id = $1
               and (status = 'pending'
                    or (status = 'sent' and sent_at < now() - interval '30 seconds'
                        and attempts < 5))
             order by priority desc, id
             limit $3
             for update skip locked
          ) pick
         where o.id = pick.id
        returning o.id, o.kind, o.text, o.channel, o.priority, o.body,
                  o.lat, o.lon, o.radius_m, o.ward_id
        """,
        city_id, gateway_id[:80], limit,
    )
    return [
        {"id": f"o{r['id']}", "kind": r["kind"], "text": r["text"],
         "channel": r["channel"], "priority": r["priority"],
         "lat": r["lat"], "lon": r["lon"], "radiusM": r["radius_m"],
         "wardId": r["ward_id"]}
        for r in sorted(rows, key=lambda x: (-x["priority"], x["id"]))
    ]


async def ack(ids: list[str]) -> int:
    nums = [int(i[1:]) for i in ids if isinstance(i, str) and i[1:].isdigit()]
    if not nums:
        return 0
    status = await db.execute(
        "update mesh_outbox set status = 'acked', acked_at = now() where id = any($1::bigint[])",
        nums,
    )
    return int(str(status).split()[-1] or 0)


async def gateway_heartbeat(hb: dict[str, Any]) -> dict:
    """Upsert the gateway phone in mesh_nodes with what it reports about itself."""
    gid = str(hb["gateway_id"])[:80]
    meta = {k: hb.get(k) for k in ("peers", "queued", "battery", "app_version", "listen",
                                   "city_id") if hb.get(k) is not None}
    meta["linked_at"] = datetime.now(UTC).isoformat()
    await db.execute(
        """
        insert into mesh_nodes (id, kind, label, lat, lon, last_seen, meta)
        values ($1, 'gateway', $2, $3, $4, now(), $5::jsonb)
        on conflict (id) do update
           set kind = 'gateway', last_seen = now(),
               label = coalesce(excluded.label, mesh_nodes.label),
               lat = coalesce(excluded.lat, mesh_nodes.lat),
               lon = coalesce(excluded.lon, mesh_nodes.lon),
               meta = mesh_nodes.meta || excluded.meta
        """,
        gid, hb.get("label"), hb.get("lat"), hb.get("lon"), meta,
    )
    pending = await db.fetchval(
        "select count(*) from mesh_outbox where status = 'pending' and city_id = $1",
        hb.get("city_id") or "pune",
    )
    return {"ok": True, "gateway_id": gid, "server_time": datetime.now(UTC).isoformat(),
            "outbox_pending": int(pending or 0), "signing": bool(settings.mesh_hmac_key)}


async def status(city_id: str = "pune") -> dict:
    nodes = await db.fetch(
        """
        select id, kind, label, lat, lon, ward_id, last_seen, meta,
               extract(epoch from now() - last_seen)::int age_s
          from mesh_nodes order by last_seen desc limit 100
        """
    )
    recent = await db.fetch(
        """
        select id, packet_id, type, node_id, gateway_id, verified, outcome, outcome_ref,
               received_at, body
          from mesh_messages order by id desc limit 60
        """
    )
    box = await db.fetchrow(
        """
        select count(*) filter (where status = 'pending') pending,
               count(*) filter (where status = 'sent') sent,
               count(*) filter (where status = 'acked') acked,
               count(*) filter (where status = 'expired') expired
          from mesh_outbox where city_id = $1 and created_at > now() - interval '24 hours'
        """,
        city_id,
    )
    return {
        "nodes": [dict(n) | {"last_seen": n["last_seen"].isoformat(),
                             "meta": _json(n["meta"])} for n in nodes],
        "recent": [dict(m) | {"received_at": m["received_at"].isoformat(),
                              "body": _json(m["body"])} for m in recent],
        "outbox": dict(box) if box else {},
        "signing": bool(settings.mesh_hmac_key),
        "enabled": bool(settings.mesh_gateway_key),
    }
