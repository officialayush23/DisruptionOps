# Setup runbook: from Android Studio to a working offline demo

Follow in order. Each part ends with a check; do not move on until it passes.
Background: [`OFFLINE_MESH.md`](OFFLINE_MESH.md), [`CHANGELOG_2026-09-26.md`](CHANGELOG_2026-09-26.md).

You need: Android Studio (recent), 2–3 Android phones (Android 8+), a USB cable,
the laptop, and access to Render and Vercel.

---

## Part A: Build the bitchat APK

1. **Open the project.** Android Studio → *Open* → `D:\GITHUB\bitchat-android`.
   Wait for the Gradle sync to finish (first time: 5–15 min; it downloads Gradle 9.5).
2. **Gradle JDK.** *File → Settings → Build, Execution, Deployment → Build Tools →
   Gradle → Gradle JDK* → choose the bundled **jbr-21** (anything 17+ works). Sync again.
3. **SDK.** The project compiles against API **37**. If sync says a platform is
   missing, click the link in the error, or *Tools → SDK Manager → SDK Platforms*,
   tick the latest (API 37), *Apply*.
4. **Check my changes are there.** In the Project view:
   `app/src/main/java/com/bitchat/android/vlm/IndradhanuGateway.kt` must exist.
5. **Build.** *Build → Build App Bundle(s) / APK(s) → Build APK(s)*
   (or in the Android Studio terminal: `.\gradlew.bat assembleDebug`).
   Use **debug**; release needs a signing key.
   - If it fails to compile, copy the first red error (file + line) and send it
     to me. The Kotlin was written without a compiler, so a small fix is possible.
6. **Find the APK.** `app\build\outputs\apk\debug\` → `app-debug.apk`
   (there may be one per CPU type; `arm64-v8a` or `universal` is the one for phones).

**Check:** the APK file exists.

---

## Part B: Install on the phones

Do this on **every** phone (at least 2).

1. If the Play Store bitchat is installed, **uninstall it first** (same app id
   `com.bitchat.droid`, different signature, so install fails otherwise).
2. Phone: *Settings → About phone → tap Build number 7×* → *Developer options →
   USB debugging ON*.
3. Plug in, accept the "Allow USB debugging" prompt.
4. Android Studio: pick the phone in the device dropdown → ▶ Run. Or:
   `adb install -r app\build\outputs\apk\debug\app-debug.apk`
   (`adb` is in `%LOCALAPPDATA%\Android\Sdk\platform-tools`).
5. Open bitchat, allow **every** permission it asks for: Nearby devices /
   Bluetooth, Location, Notifications.
6. *Settings → Apps → bitchat → Battery → Unrestricted*, so the mesh keeps
   running with the screen off.
7. Set a nickname per phone (e.g. `gateway`, `citizen1`, `crew1`).
8. In bitchat's chat box type `/j #indradhanu` and `/j #field` so people can
   read the control room's broadcasts. (The app's inbox receives them either way.)

**Check:** with Bluetooth on, each phone shows the others as peers (people icon /
peer count) within a minute.

---

## Part C: Turn on the local API (every phone)

1. In bitchat: open the **About / Settings** sheet → **Settings** tab → **VLM API**
   → turn **Enable** on. Leave the port at **8765**.
2. **Force-stop and reopen bitchat** (*Settings → Apps → bitchat → Force stop*):
   the API server only starts when the mesh service starts.
3. Test from the laptop, phone on USB:
   ```powershell
   adb forward tcp:8765 tcp:8765
   curl.exe http://127.0.0.1:8765/status
   curl.exe "http://127.0.0.1:8765/inbox?since=0"
   curl.exe http://127.0.0.1:8765/gateway
   ```

**Check:** `/status` shows `"api_enabled":true` and a `peers_count`;
`/inbox` answers `"status":"ok"` (if it says *Not found*, the phone is running an
old build, so go back to Part A); `/gateway` shows `"enabled":false`.

---

## Part D: Keys, backend, deploy

1. Generate two secrets on the laptop:
   ```powershell
   python -c "import secrets;print(secrets.token_urlsafe(32))"   # -> MESH_GATEWAY_KEY
   python -c "import secrets;print(secrets.token_urlsafe(32))"   # -> MESH_HMAC_KEY
   ```
2. Put both in `backend\.env` (local runs) **and** in Render → your service →
   *Environment* → add `MESH_GATEWAY_KEY`, `MESH_HMAC_KEY` → *Save*.
3. The database needs nothing: migrations 020, 021 and 022 are already applied.
4. Run the tests (from `backend`, inside your venv):
   `python -m unittest discover -s tests -v` → 26 tests OK.
5. Run locally once: `uvicorn app.main:app --reload --port 8000`. Open the
   console, start the demo, and make sure nothing errors in the terminal.
6. Commit and push DisruptionOps (review the diff first). Render and Vercel
   redeploy on push.
7. Check the deployed API:
   ```powershell
   $api = "https://disruptionops.onrender.com"
   curl.exe -H "X-Mesh-Gateway-Key: <MESH_GATEWAY_KEY>" "$api/api/v1/mesh/outbox?gateway_id=test"
   ```

**Check:** the last call returns `{"messages":[...]}` (an empty list is fine),
not 403.

---

## Part E: Make one phone the gateway

Pick the phone that **will have mobile data** during the demo. On the laptop,
with that phone on USB (`adb forward tcp:8765 tcp:8765` as before):

```powershell
$body = @{ enabled = $true; api_url = "https://disruptionops.onrender.com";
           gateway_key = "<MESH_GATEWAY_KEY>"; gateway_id = "gw-1" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8765/gateway -Body $body -ContentType "application/json"
Invoke-RestMethod http://127.0.0.1:8765/gateway
```

**Check:** `enabled: True`, `online: True`, `gateway_key_set: True`, no `last_error`.

*No phone with data?* Use the laptop as the gateway instead (Part G, option 2).

---

## Part F: First end-to-end test, without real phones (5 minutes)

From `backend`:

```powershell
python scripts\mesh_bridge.py sim --api https://disruptionops.onrender.com `
  --key <MESH_GATEWAY_KEY> --hmac <MESH_HMAC_KEY> `
  --report flooded_road 18.5204 73.8567 "Water knee deep near the signal"
```

**Check:** the first result says `"outcome": "report"` (or `linked`), the second
says `"duplicate"`, and the incident appears on the console map.

---

## Part G: Real phones

### Option 1: a citizen phone with no signal

1. On the **citizen** phone, *with internet*, open the citizen site in Chrome,
   *Add to Home screen*, and ask for a route once (this caches the app and your
   route).
2. Turn **mobile data and Wi-Fi off**; keep **Bluetooth on**. Keep bitchat running.
3. Open the installed app. A **Mesh mode** panel appears ("The server is out of
   reach"). The first time, Chrome asks to allow access to devices on your
   local network: **Allow**.
4. It should say *bitchat connected · N phones in range*. Type a report, tap
   **Send what I typed through the mesh**.
5. The **gateway** phone (Part E) hears it and forwards it within ~5 s of
   having data.

**Check:** the incident appears on the console; `curl.exe http://127.0.0.1:8765/gateway`
on the gateway shows `queued: 0` and a recent `last_forward_ok_ms`.

### Option 2: the laptop as gateway (no app rebuild needed)

Laptop and a bitchat phone on the same Wi-Fi (or USB with `adb forward`):

```powershell
python scripts\mesh_bridge.py --api https://disruptionops.onrender.com `
  --key <MESH_GATEWAY_KEY> --phone <phone-ip or 127.0.0.1>
```

It prints `[in ]` for every packet forwarded and `[out]` for every alert or
dispatch broadcast.

### Alerts coming back

1. On the console, approve an advisory in the affected ward (or run a scenario,
   below).
2. Within ~10 s the gateway broadcasts it. The citizen phone shows it in bitchat
   (`#indradhanu`) and in the Mesh mode panel, with its distance.

**Check:** alert text visible on the offline phone.

---

## Part H: The camera node (optional)

1. `D:\GITHUB\ai-surveillance\configs\pipeline.yaml`:
   - `bitchat.ip`: the Wi-Fi IP of a bitchat phone
   - `indradhanu.enabled: true`, `api`, `gateway_key`, `hmac_key`, `node_id`,
     and the camera's real `lat` / `lon`
   - keep `disaster_mode: true`
2. `python -m pipeline.main_loop`. The log prints `[indradhanu] bridge on …`
   and, per detection, `https 200 …` (online) or `mesh 200 …` (offline).

**Check:** a fire held up to the camera (a phone video works) becomes an
incident marked with the camera as its source.

---

## Part I: Show the rest

- **Scenarios** (console logged in as staff):
  `POST /api/v1/demo/scenarios/block_on_approach/run`, then
  `GET /api/v1/demo/scenarios/last` for PASS/FAIL. Names: `flood_cascade`,
  `block_on_approach`, `unit_breakdown`, `officer_redirect`, `officer_hold`,
  `camera_fire_mesh`, `mesh_blackout_sos`, `multi_hazard_surge`.
- **Cancel / do instead:** *Who is on what* → *Cancel…* on a unit, or ask the
  Copilot "cancel <unit> and hold it for 20 minutes".
- **Incident Commander:** Copilot page, left column → *Wake it* (needs
  `GEMINI_API_KEY` or Bedrock configured).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Gradle sync: "requires Java 17" | Part A step 2 |
| "Failed to find target android-37" | Part A step 3 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Uninstall the old bitchat (Part B step 1) |
| `/status` connection refused | VLM API off, or bitchat not restarted after enabling (Part C step 2) |
| `/inbox` → Not found | Old APK on the phone; reinstall the new build |
| Gateway `last_error: inbound HTTP 403` | Key mismatch, or `MESH_GATEWAY_KEY` not set on Render |
| `online: false` on the gateway | No validated internet on that phone (captive portal, no data) |
| Mesh panel: "bitchat not found" | VLM API off, or the local-network prompt was blocked: Chrome → site settings → *Local network access* → Allow |
| Phones do not see each other | Bluetooth + Location on, all permissions granted, battery unrestricted, within ~10 m for the first test |
| `/send/text` → 400 "Rate limited" | Normal: 5 s between sends. The gateway and bridge wait for it |
| API returns `"outcome": "refused"`, "outside every ward" | The lat/lon is outside the city's wards; use a Pune coordinate |
