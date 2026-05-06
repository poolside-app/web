# Poolside gate bridge — install + Bishop Estates migration

This is the on-site Python service that bridges the Poolside cloud to the
gate panel on the club's LAN. It runs on a Windows PC inside the club,
polls the Poolside cloud every ~1.5 seconds, and runs the proven 2-step
HTTP recipe against the panel when there's an unlock to fire.

> **For Bishop Estates specifically — migrating from the old single-tenant
> bridge:** scroll to the bottom **"Bishop Estates migration"** section.
> The first half of this README is the generic install for any club.

## What you need

- The on-site Windows PC the club already has wired into the same LAN as
  the gate panel.
- AnyDesk (or RDP / TeamViewer / physical access) — once installed, the
  service runs on its own. You can disconnect AnyDesk and it keeps going.
- 15–25 minutes total.

---

## Generic install (any club)

### 1. Get your bridge credentials

- Sign into the club's Poolside admin
- Settings → scroll to **🔐 Remote keyfob access** card
- Click **Rotate bridge secret**
- A popup shows two values: `bridge_id` (a UUID) and `bridge_secret` (long random string)
- **Copy both immediately — the plaintext secret only displays once.** If
  you click away before saving it, just rotate again.

### 2. RDP / AnyDesk into the on-site PC

### 3. Install Python (if not already there)

```powershell
python --version
```

If you get "Python was not found", install Python 3.11+ from
<https://python.org>. Tick **"Add Python to PATH"** during install.

### 4. Drop in the bridge code

Copy this entire `bridge/` folder to the on-site PC at `C:\PoolsideGateBridge\`.

You can:
- Clone the repo and copy: `git clone https://github.com/poolside-app/web ; xcopy web\bridge C:\PoolsideGateBridge\ /E /I`
- Or download just this folder as a zip and extract.

### 5. Set up the Python virtualenv + install deps

In a PowerShell at `C:\PoolsideGateBridge\`:

```powershell
python -m venv venv
venv\Scripts\pip install -r requirements.txt
```

### 6. Create your `.env`

```powershell
copy .env.example .env
notepad .env
```

Replace these placeholders with the values from step 1:

```
BRIDGE_ID=PASTE_BRIDGE_ID_FROM_POOLSIDE_ADMIN
BRIDGE_SECRET=PASTE_BRIDGE_SECRET_FROM_POOLSIDE_ADMIN
```

The panel host, user, password, and `logId` are stored in **Poolside admin
→ Settings → Remote keyfob access** and pulled fresh on every poll, so
they don't go in the bridge's `.env`. You configure them once in the admin
UI; the bridge reads them automatically.

Save + close Notepad.

### 7. Smoke test in the foreground

```powershell
venv\Scripts\python gate_bridge.py
```

You should see within 2 seconds:
```
INFO Poolside gate bridge 1.0.0-poolside starting
INFO   cloud:  https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/gate_bridge
INFO   bridge: <your-bridge-id>
INFO   poll every 1.5s, heartbeat every 30s
INFO First heartbeat ok — credentials accepted.
```

Open Poolside admin → Settings → Remote keyfob access. The bridge health
pill should flip to **🟢 Bridge online** within 5 seconds.

Click **Test unlock** in the admin. The console should log:
```
INFO Picked up unlock 8adf72cc... (admin test)
INFO   → ok: panel returned 200
```

The gate should physically open within ~2 seconds.

If anything goes wrong here, **fix it before installing as a service** —
the foreground console is much easier to debug than a Windows service.

Press `Ctrl+C` to stop the foreground test once you've verified.

### 8. Install as a Windows service via nssm

Download nssm from <https://nssm.cc/> if it isn't already on the PC. Then:

```powershell
nssm install PoolsideGateBridge "C:\PoolsideGateBridge\venv\Scripts\python.exe" "C:\PoolsideGateBridge\gate_bridge.py"
nssm set PoolsideGateBridge AppDirectory C:\PoolsideGateBridge
nssm set PoolsideGateBridge AppStdout C:\PoolsideGateBridge\bridge.log
nssm set PoolsideGateBridge AppStderr C:\PoolsideGateBridge\bridge.log
nssm set PoolsideGateBridge Start SERVICE_AUTO_START
nssm start PoolsideGateBridge
```

### 9. Verify it's running and survives a reboot

```powershell
# Should say RUNNING
nssm status PoolsideGateBridge

# Tail the log — you should see new heartbeat lines every 30 seconds
Get-Content C:\PoolsideGateBridge\bridge.log -Tail 20 -Wait
```

Open `services.msc` (Run dialog → `services.msc`):
- Find `PoolsideGateBridge`
- Status: **Running**
- Startup type: **Automatic**

You can now safely disconnect AnyDesk. The service keeps running with the
PC powered on; if the PC reboots, the service comes back up automatically.

### 10. Final test from your phone

On your phone, sign into the member side at `<club-slug>.poolsideapp.com/m/`.
You should see a navy "🚪 Unlock the gate" card. Tap it. The gate should
open within ~3 seconds.

---

## Bishop Estates migration

You're moving off the old single-tenant Bishop Estates app. This means
**completely uninstalling** the old `GateBridge` service and replacing it
with `PoolsideGateBridge`. Don't run both — either works alone, but the
old one points at a Supabase project we're abandoning.

### Step 1. RDP into the on-site PC via AnyDesk

### Step 2. Stop and uninstall the old service

In an Administrator PowerShell:

```powershell
nssm stop GateBridge
nssm remove GateBridge confirm
```

Verify it's gone:
```powershell
nssm status GateBridge
# Expected: "Can't open service!" — that's good, it means it's removed.
```

### Step 3. (Optional but tidy) Archive the old folder

```powershell
ren C:\GateBridge C:\GateBridge.OLD-BE-archive-2026-05
```

That keeps the old Python in case you ever want to look at it but moves it
out of the way. Or just delete it outright:

```powershell
rmdir /s /q C:\GateBridge
```

### Step 4. Follow the generic install above (steps 4–9)

The Python venv setup, `.env`, smoke test, and `nssm install` are all the
same as for any other club. Bishop Estates is already pre-seeded as
`active` in Poolside, so step 1 (rotate bridge secret) works the moment
you open the admin.

### Step 5. Confirm the migration

After the new `PoolsideGateBridge` service is running:

1. Old `GateBridge` service: **gone** (`nssm status GateBridge` says
   "Can't open service")
2. New `PoolsideGateBridge` service: **Running** in `services.msc`
3. Poolside admin Settings → Remote keyfob access: bridge health
   **🟢 online**
4. From your phone, signed in as a Bishop Estates member:
   `bishopestates.poolsideapp.com/m/` shows the **🚪 Unlock the gate**
   card; tap it; gate opens.

You can now safely disconnect AnyDesk.

---

## Troubleshooting

**"Auth failed (401). Check BRIDGE_ID and BRIDGE_SECRET in .env"**
You either typo'd the values or the secret was rotated AFTER you pasted
it. Go back to Poolside admin and rotate again — the latest plaintext is
the only one that works.

**"Forbidden (403). The tenant gate add-on is not 'active'"**
Bishop Estates should already be active. If you see this for a different
tenant, the platform owner needs to flip the status to 'active' in
`/admin/gate-integrations.html` after invoicing.

**Bridge is online but Test unlock fails with `panel_unreachable`**
The Python can't reach the panel on the LAN. Check:
- Panel IP in admin Settings matches what you actually have
  (`ping 10.1.10.153` from the on-site PC should return responses)
- Panel is powered on
- Bridge PC and panel are on the same VLAN (some routers segment WiFi
  from wired)

**Bridge is online but Test unlock fails with `login HTTP 401` or `403`**
Panel admin user/password in Poolside admin is wrong. Update them in
Settings; the bridge picks up the new creds on its next poll (within ~2s).

**"Picked up unlock" but the gate doesn't physically open, despite ok=True**
The 2-step recipe returned 200 from the panel, but the panel didn't
actually fire the relay. Possible causes:
- Panel firmware is older than 2.4.7 — recipe was tested on that version,
  may need adjustment for older
- Panel's "remote unlock" feature is disabled in its own admin UI — log
  into the panel directly (`http://<panel-ip>`) and check
- Door 1 is wired but the recipe used UNCLOSE2 — check `door` field in
  the unlock command (look at admin → Recent unlocks → result_detail)

**Bridge running but heartbeat lags / sometimes shows 🟡 stale**
Network is briefly dropping out. Check whether the on-site PC is on WiFi
(not great for always-on services) — wired ethernet is much more reliable.
A 30-second hiccup is harmless; persistent slow heartbeats means the PC
or its connection is unstable.

---

## Updating the bridge code later

When we ship a new bridge version (panel adapter for a new vendor, bug
fix, etc.):

```powershell
nssm stop PoolsideGateBridge
# Replace gate_bridge.py + requirements.txt as needed
venv\Scripts\pip install -r requirements.txt --upgrade
nssm start PoolsideGateBridge
```

The `.env` stays put — your bridge_id and bridge_secret don't change on
upgrades.
