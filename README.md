# ABB GoFa 12 (CRB 15000-12/1.27) — Node-RED Palette

Node-RED palette for controlling the **ABB GoFa 12** (CRB 15000-12/1.27) collaborative robot over the network — no extra ABB licenses or hardware required beyond the standard OmniCore C30 controller.

## What's in this repo

```
node-red-contrib-abb-gofa/       ← Node-RED palette (npm installable)
rapid/
  MainModule.mod                 ← RAPID socket server (must run on controller)
  GoFaControl.pgf                ← Program group file
flows/
  gofa_demo_flow.json            ← Demo flow — one inject per node
  dashboard_flow.json            ← Full robot control palette flow
dist/
  node-red-contrib-abb-gofa-*.tgz ← Packaged releases
```

---

## Requirements

- ABB GoFa 12 (CRB 15000-12/1.27) with OmniCore C30 controller
- RobotWare 7.x (tested on 7.21.0)
- Node-RED v3+
- Node.js v18+
- RobotStudio (free) — only needed once for user permission setup

No extra RobotWare options required. RWS (Robot Web Services) is built into every OmniCore controller.

---

## Quick start

1. [Set your robot's IP address](#1-set-your-robot-ip) (if different from `192.168.20.12`)
2. [Create an RWS user with Remote Start/Stop permission](#2-create-an-rws-user-robotstudio)
3. [Upload and run the RAPID program](#3-upload-and-run-the-rapid-program)
4. [Install the Node-RED palette](#4-install-the-node-red-palette)
5. [Configure the robot config node](#5-configure-the-robot-config-node)

---

## 1. Set your robot IP

If your robot's IP address is **not** `192.168.20.12`, you need to update it in three places before doing anything else.

### Find your robot's IP

On the **FlexPendant**: ABB menu → **Control Panel** → **Network Settings** — the LAN port IP is shown there.

### Update the repo files

Run this in your terminal from the repo root (replace `X.X.X.X` with your IP):

**Windows (PowerShell):**
```powershell
$old = "192.168.20.12"; $new = "X.X.X.X"
Get-ChildItem -Recurse -Include *.js,*.html,*.json,*.mod,*.md |
  ForEach-Object { (Get-Content $_) -replace $old, $new | Set-Content $_ }
```

**Linux / macOS:**
```bash
find . -type f \( -name "*.js" -o -name "*.html" -o -name "*.json" -o -name "*.mod" -o -name "*.md" \) \
  | xargs sed -i 's/192\.168\.20\.15/X.X.X.X/g'
```

**Files this touches:**
| File | What it sets |
|------|-------------|
| `rapid/MainModule.mod` | IP the RAPID socket server binds to |
| `node-red-contrib-abb-gofa/nodes/gofa-robot.js` | Default IP in the config node |
| `node-red-contrib-abb-gofa/nodes/gofa-robot.html` | Placeholder in the UI |
| `flows/gofa_demo_flow.json` | Stored IP in the demo flow config |
| `flows/dashboard_flow.json` | Stored IP in the dashboard flow config |

> **Why MainModule.mod?** The RAPID socket server explicitly binds to the controller's own IP address. If this doesn't match the actual IP, the socket server silently fails to start and all TCP commands will time out.

---

## 2. Create an RWS user (RobotStudio)

The built-in `Admin` account cannot start or stop RAPID remotely. You need to create a dedicated user with Remote Start/Stop permission. This is a one-time setup done in RobotStudio.

### Open RobotStudio and connect

1. Open **RobotStudio** (free download from ABB)
2. **Controller** tab → **Add Controller** → enter your robot's IP → connect
3. Log in as `Admin` / `robotics` when prompted

### Create a role and assign it to the user

4. Click **Authenticate** in the ribbon and log in with an admin account — UAS edits require this first

   *(If you don't see **Edit User Accounts**: try right-clicking the controller name in the left panel → look for Authorization or User Accounts)*

5. Click **Edit User Accounts**
6. In the **Role** tab → click **Add Role**
7. Set a role name (e.g. `RemoteControl`) → leave the rest as-is → in the **Grants** / **Permissions** list, enable:
   - ✅ **Remote Start** (allows `start` action via RWS)
   - ✅ **Remote Stop** (allows `stop` and `resetpp` actions via RWS)
   - ✅ All other grants you want (read-only operations work without grants)
8. Switch to the **User** tab → either change an existing user's role to the one you just created, or click **Add User** to create a new user (e.g. `nodeuser` / `robotics`) and assign it the new role
9. Click **OK** → **Apply**

> **What about `resetpp`?** It requires edit mastership in addition to Remote Stop — the palette handles this automatically using `/rw/mastership/edit/request`.

### Update the palette credentials

Edit `node-red-contrib-abb-gofa/nodes/gofa-robot.js` and `gofa-robot.html` — replace `NNNN` with your chosen username:

```bash
# Linux / macOS
sed -i "s/NNNN/nodeuser/g" \
  node-red-contrib-abb-gofa/nodes/gofa-robot.js \
  node-red-contrib-abb-gofa/nodes/gofa-robot.html \
  flows/gofa_demo_flow.json \
  flows/dashboard_flow.json
```

---

## 3. Upload and run the RAPID program

The RAPID socket server (`MainModule.mod`) must be running on the controller for all motion commands to work. RWS-only nodes (status, pose, joints, I/O) work without it.

### Upload the file

```bash
curl -sk -u <username>:<password> -X PUT -H "Content-Type: text/plain;v=2.0" \
  --data-binary @rapid/MainModule.mod \
  "https://<ROBOT_IP>/fileservice/\$HOME/Programs/MainModule.mod"
# Expected response: HTTP 200
```

### Load and start on the FlexPendant

1. Key switch → **AUTO** mode
2. Enable motors (green button or ABB menu → **Production Window** → motors on)
3. **Program Editor** → **File** → **Load Program** → navigate to `$HOME/Programs/` → select `MainModule.mod`
4. **PP to Main** → press **Play** (▶)

The robot is now listening for socket commands on port **1025**.

### Test the connection

```bash
# Linux / macOS
printf 'PING\n' | nc -w 3 <ROBOT_IP> 1025
# Expected: OK:PING

# Windows PowerShell
$tcp = New-Object System.Net.Sockets.TcpClient("<ROBOT_IP>", 1025)
$s = $tcp.GetStream(); $b = [System.Text.Encoding]::ASCII.GetBytes("PING`n")
$s.Write($b,0,$b.Length); Start-Sleep -m 500
$r = New-Object byte[] 64; $n = $s.Read($r,0,64)
[System.Text.Encoding]::ASCII.GetString($r,0,$n)
$tcp.Close()
```

---

## 4. Install the Node-RED palette

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-abb-gofa
```

Or from a packaged release:

```bash
cd ~/.node-red
npm install /path/to/dist/node-red-contrib-abb-gofa-1.0.1.tgz
```

Restart Node-RED. The **ABB GoFa** section will appear in the palette sidebar.

> **Note (local install):** npm 7+ creates a symlink instead of copying. The palette depends on the `ws` package — run `npm install` once inside the palette directory to make sure it resolves correctly:
> ```bash
> cd /path/to/node-red-contrib-abb-gofa && npm install
> ```

---

## 5. Configure the robot config node

Every GoFa node shares a single **gofa-robot** config node. Open any GoFa node → click the pencil icon next to **Robot**:

| Field | Default | Description |
|-------|---------|-------------|
| Robot IP | `192.168.20.12` | Controller IP — must match Step 1 |
| RWS Port | `443` | HTTPS port (built-in, do not change) |
| Socket Port | `1025` | TCP port for the RAPID socket server |
| Username | `NNNN` | The user you created in Step 2 |
| Password | `robotics` | The password you set in Step 2 |
| Points File | `points.json` | Saved robot positions on the Node-RED host |

Click **Update** → **Deploy**.

---

## Import the demo flow

**Menu → Import → select a file:**

| Flow | What it does |
|------|-------------|
| `flows/gofa_demo_flow.json` | One inject per node — good for testing each feature |
| `flows/dashboard_flow.json` | Full robot control palette flow |

After importing, open the **gofa-robot** config node (click any GoFa node → pencil icon) and verify the IP and credentials match your setup.

---

## Nodes reference

Protocol key: **TCP** = RAPID socket server port 1025 · **RWS** = HTTPS REST API port 443 · **WS** = RWS WebSocket · **Local** = no network (`points.json` on Node-RED host)

### Read robot state

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-status** | RWS | Controller state, op-mode, speed %, RAPID exec state |
| **gofa-pose** | RWS | TCP position (x, y, z mm + quaternion + config flags) |
| **gofa-joints** | RWS | All 6 joint angles in degrees |
| **gofa-system-info** | RWS | RobotWare version, controller name/ID/MAC |
| **gofa-elog** | RWS | Controller event log |

### Motion

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-motor** | RWS | Motors on / off |
| **gofa-speed-set** | TCP | Speed override 1–100% |
| **gofa-move** | TCP | HOME (go to home) or SETHOME (save current pose as home) |
| **gofa-movej** | TCP | Absolute joint move `[j1..j6]` degrees |
| **gofa-jog** | TCP | Relative TCP translate (mm, base frame) or rotate (°, tool frame) |
| **gofa-joint-jog** | TCP | Rotate single joint by ± degrees |
| **gofa-zone-set** | TCP | Path blend zone (fine / z1 / z5 / z10 / z20 / z50 / z100) |
| **gofa-stop-motion** | TCP | Halt motion immediately |
| **gofa-ping** | TCP | Round-trip latency test |
| **gofa-grip** | TCP | GRIPON / GRIPOFF via digital output |
| **gofa-leadthrough-enable** | TCP + RWS | Send STOP (clears queued moves), then activate hand-guiding |
| **gofa-leadthrough-disable** | RWS | Deactivate hand-guiding |
| **gofa-asi-led** | TCP | Set ASI status light RGB color (`0–255`) and blink; supports counted software blink |

### Saved points

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-save-point** | RWS + Local | Read current pose, save as named point in `points.json` |
| **gofa-go-point** | TCP + Local | Look up a saved point and move to it — move type (Joint/MoveJ or Linear/MoveL) selectable |
| **gofa-point-list** | Local | Output the full saved-points array |
| **gofa-delete-point** | Local | Remove a saved point by name |
| **gofa-points-export** | Local | Dump points list to `msg.payload` |
| **gofa-points-import** | Local | Replace points list from `msg.payload` |
| **gofa-sequencer** | TCP + Local | Visit saved points in order — per-step dwell + move type override, loop count, ping-pong, startStep |
| **gofa-stop-seq** | TCP + Local | Stop sequencer immediately (sends `STOP` socket + sets flag) |

> **Move type — Joint (MoveJ) vs Linear (MoveL):** `gofa-go-point` and `gofa-sequencer` let you pick how the robot reaches a saved point. **Joint (MoveJ)** is joint-interpolated and is the default whenever a move type isn't set or an invalid value is passed — it's the more predictable/reliable choice because RAPID has freedom in how each axis gets there, so it won't fault or slow drastically near a singularity. **Linear (MoveL)** forces a straight-line TCP path, which is useful for a controlled approach/retract near a workpiece but can hit a singularity or joint limit along that line even when both endpoints are fine on their own.

### RAPID program control

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-rapid-exec** | RWS | `start` / `stop` / `resetpp` the RAPID program |
| **gofa-rapid-var-read** | TCP | Read a RAPID PERS variable via `GETVAR:<name>` socket command |
| **gofa-rapid-var-write** | TCP | Write a RAPID PERS variable via `SETVAR:<name>:<value>` socket command |

> `gofa-rapid-exec` requires the RWS user to have **Remote Start** and **Remote Stop** grants (see Step 2). `resetpp` additionally acquires edit mastership automatically.

> `gofa-rapid-var-read` / `gofa-rapid-var-write` use the TCP socket and work on standard OmniCore C30 without any extra RobotWare options. The variable must be listed in `TryGetVar` / `TrySetVar` in `MainModule.mod`. Built-in test variables: `nTestVar` (num) and `sTestMsg` (string). See [Adding RAPID variables](#adding-rapid-variables) below.

### Files and I/O

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-file-read** | RWS | Download a file from the controller filesystem |
| **gofa-upload-mod** | RWS | Upload a `.mod` file — local path set in node properties or via `msg.payload` |
| **gofa-io-list** | RWS | List all I/O signals |
| **gofa-di-read** | RWS | Read a digital input (0 or 1) |
| **gofa-ai-read** | RWS | Read an analog input |
| **gofa-do-write** | RWS | Write a digital output (0 or 1) |
| **gofa-ao-write** | RWS | Write an analog output (float) |

### Real-time subscriptions

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-subscribe-state** | WS | Push on every controller state change; one-shot mode polls once per inject |
| **gofa-subscribe-io** | WS / poll | Push on every I/O signal change; falls back to 500 ms polling for signals that don't support WebSocket; one-shot mode polls once per inject |
| **gofa-subscribe-var** | RWS poll | Poll a RAPID variable on an interval |
| **gofa-subscribe-pose** | RWS poll | Poll TCP position on an interval |

> **One-shot checkbox** — both `gofa-subscribe-state` and `gofa-subscribe-io` have a **One-shot** option in their properties. When checked, each inject triggers a single poll and returns the current value immediately without opening a persistent subscription.

---

## Adding RAPID variables

`gofa-rapid-var-read` and `gofa-rapid-var-write` communicate via the TCP socket using `GETVAR:<name>` and `SETVAR:<name>:<value>` commands. The supported variables are declared inside `MainModule.mod` — you add one `ELSEIF` block per variable in two functions:

```rapid
! In TryGetVar — read side
ELSEIF varname = "MYSPEED" THEN
    SocketSend clientSocket \Str:=("VAL:" + NumToStr(nMySpeed, 6) + ByteToStr(10\Char));

! In TrySetVar — write side
ELSEIF varname = "MYSPEED" THEN
    IF NOT StrToVal(valstr, nMySpeed) THEN
        SocketSend clientSocket \Str:=("ERR:PARSE" + ByteToStr(10\Char));
        RETURN TRUE;
    ENDIF
    SocketSend clientSocket \Str:=("OK:SETVAR" + ByteToStr(10\Char));
```

> Variable names in socket commands are **uppercased** automatically (`nMySpeed` → sent as `GETVAR:nMySpeed` → matched as `NMYSPEED`). String values sent to `SETVAR` preserve their original case and spaces.

After editing `MainModule.mod`, re-upload it and reload on the FlexPendant.

---

## msg.payload conventions

Every node that has configurable action parameters follows the same priority chain:

```
msg.payload  →  node property (editor)  →  built-in default
```

### Nodes with configurable payload

| Node | Accepted payload forms | Default |
|------|----------------------|---------|
| **gofa-motor** | `'motoron'` / `'motoroff'` (string) · `{ action: 'motoron' }` | `motoron` |
| **gofa-move** | `'HOME'` / `'SETHOME'` (string) · `{ command: 'HOME' }` | `HOME` |
| **gofa-rapid-exec** | `'start'` / `'stop'` / `'resetpp'` (string) · `{ action: 'start' }` | `start` |
| **gofa-speed-set** | number or string `1`–`100` | `50` |
| **gofa-zone-set** | `'fine'` / `'z1'` / `'z5'` / `'z10'` / `'z20'` / `'z50'` / `'z100'` | `z10` |
| **gofa-grip** | `true` / `1` / `'on'` / `'gripon'` or `false` / `0` / `'off'` / `'gripoff'` · `{ action: 'on' }` | `on` |
| **gofa-jog** | `{ axis, dir, step }` | X, +, 10 |
| **gofa-joint-jog** | `{ joint, dir, step }` | J1, +, 5 |
| **gofa-movej** | `[j1,j2,j3,j4,j5,j6]` or `{ j1, j2, j3, j4, j5, j6 }` | `[0,0,85,0,0,0]` |
| **gofa-go-point** | `{ name, moveType? }` or `{ id, moveType? }` — `moveType`: `"J"` or `"L"` | (property) |
| **gofa-save-point** | `{ name }` | (property) |
| **gofa-delete-point** | `{ name }` or `{ id }` | (property) |
| **gofa-rapid-var-read** | `{ task, module, variable }` | T_ROB1 / MainModule / (property) |
| **gofa-rapid-var-write** | bare value · `{ variable, value }` | (property) |
| **gofa-do-write** | `0` or `1` (number) · `{ signal, value }` | signal: DO10_1, value: 0 |
| **gofa-ao-write** | float (number) · `{ signal, value }` | signal: AO1, value: 0.0 |
| **gofa-ai-read** | signal name (string) | `AI1` |
| **gofa-di-read** | signal name (string) | `DI10_1` |
| **gofa-subscribe-io** | `{ signal }` | `DI10_1` |
| **gofa-subscribe-var** | `{ task, module, variable }` (toggles polling) | T_ROB1 / MainModule / (property) |
| **gofa-subscribe-pose** | `{ interval }` ms on start · absent = stops if running | 500 ms |
| **gofa-file-read** | file path (string) · `{ remotePath, encoding }` | `$HOME/Programs/MainModule.mod` |
| **gofa-upload-mod** | `Buffer` · file path (string) · `{ localPath, remotePath }` | (property) |
| **gofa-points-export** | file path (string) · `{ savePath }` | (property / no file) |
| **gofa-points-import** | file path (string) · `{ loadPath }` · array · `{ points: [...] }` | (property / clear) |
| **gofa-elog** | `{ domain, count }` | domain: 1, count: 10 |
| **gofa-asi-led** | `'red'`/`'green'`/`'yellow'`/`'off'`/etc. · `false`/`0` (off) · `{ color, r, g, b, period, blinkCount, blinkMs }` · `'reset'` (restore default) | node defaults |
| **gofa-sequencer** | `{ steps, dwell, moveType, loop, pingpong, count, startStep }` — `steps[i].moveType` overrides per-step | (property) |

### Trigger-only nodes (no payload needed)

These nodes fire on any input message and ignore `msg.payload`:

`gofa-status` · `gofa-pose` · `gofa-joints` · `gofa-system-info` · `gofa-ping` ·
`gofa-stop-motion` · `gofa-stop-seq` · `gofa-point-list` ·
`gofa-leadthrough-enable` · `gofa-leadthrough-disable`

> **gofa-asi-led** — `msg.payload` is required. Use a color string (`'yellow'`), a preset object (`{ color: 'green', blinkCount: 3, blinkMs: 250 }`), or `'reset'` to restore the controller's default green LED. Omit `blinkCount` (or set to `0`) to use the hardware `period` signal for continuous blinking instead.

---

## How it works

**Two communication layers:**

```
Node-RED ──TCP 1025──▶ RAPID socket server (MainModule.mod)
                            └─ motion, GETVAR/SETVAR, PING …

Node-RED ──HTTPS 443──▶ RWS built into OmniCore
                            └─ read state, motor on/off, RAPID start/stop, I/O
```

All motion commands go through the RAPID TCP socket. This avoids mastership conflicts with the FlexPendant and gives instant `OK:` acknowledgment before the move executes. RWS is used only for reads and non-motion control.

Saved points are stored in `points.json` on the Node-RED host — not on the robot.

---

## Troubleshooting

### Socket commands time out (jog, HOME, ping …)

1. Confirm RAPID is running on the FlexPendant (green play indicator)
2. Check `rapid/MainModule.mod` — `SERVER_IP` must match your robot's actual IP. If you upload via the `gofa-upload-mod` node, this is kept in sync automatically from the `gofa-robot` config node's IP — no manual edit needed.
3. Re-upload the `.mod` and reload on the FlexPendant if you changed the IP
4. Verify port 1025 is reachable: `nc -zv <ROBOT_IP> 1025`

### RAPID Var Read/Write returns `ERR:UNKNOWN_VAR`

The variable is not in the `TryGetVar` / `TrySetVar` handlers in `MainModule.mod`. Add an `ELSEIF` block for it (see [Adding RAPID variables](#adding-rapid-variables)), re-upload, and reload on the FlexPendant.

### RWS returns 401

Session expired. The palette auto-retries with credentials — if it keeps failing, check the username and password in the config node.

### `gofa-rapid-exec` returns 403

| Error code | Cause | Fix |
|------------|-------|-----|
| `icode:-757` | User lacks Remote Start/Stop grant | RobotStudio → Edit User Accounts → add Remote Start/Stop grants |
| `org_code:-4501` on resetpp | Edit mastership not acquired | Update to latest palette — `resetpp` now wraps in `withMastership('edit')` automatically |

### `gofa-subscribe-*` shows "unknown node type"

Run `npm install` inside the palette directory so the `ws` package resolves when npm has symlinked the package:

```bash
cd /path/to/node-red-contrib-abb-gofa && npm install
```

Then restart Node-RED.

### Subscribe IO falls back to polling for some signals

Some signals (e.g. AS-Interface / ASI signals) do not support WebSocket subscription. `gofa-subscribe-io` automatically falls back to 500 ms polling for these signals — no action needed and no warning is shown.

### RWS returns 405 (method not allowed)

This palette targets **OmniCore / RWS 2.0** which uses path-based actions (e.g. `/rw/rapid/execution/start`). If you see 405, you may be connecting to an IRC5 controller running RWS 1.0 — the endpoint format is different.

---

## Default connection settings

| Setting | Value |
|---------|-------|
| Robot IP | `192.168.20.12` |
| RWS port | `443` (HTTPS, self-signed cert) |
| Socket port | `1025` |
| Username | `NNNN` |
| Password | `robotics` |

The self-signed HTTPS certificate on the controller is accepted automatically (`rejectUnauthorized: false`).
