# ABB GoFa 12 (CRB 15000-12/1.27) — Node-RED Palette

Node-RED palette for controlling the **ABB GoFa 12** (CRB 15000-12/1.27) collaborative robot over the network — no extra ABB licenses or hardware required beyond the standard OmniCore C30 controller.

## ⚠️ Safety and security

**This software moves a real robot arm.**

- The software **STOP** command and Node-RED itself are *not* safety functions. The robot's own safety controller, reduced-speed collaborative limits, and the physical emergency stop are the only real safety layer — never rely on a flow to keep people safe.
- The RAPID socket server (port 1025) accepts motion commands from **anyone who can reach the robot's IP — there is no authentication on that port**. Run the robot on an isolated or firewalled network segment. RWS credentials are sent over HTTPS with certificate checking disabled (self-signed controller cert), so the same isolation assumption applies there.
- Jog/rotate step limits (50 mm / 30° per command) are enforced in the RAPID module, not in Node-RED — if you edit `MainModule.mod`, keep them.

## 2.0.0 breaking changes

Six single-action nodes were merged into three action-dropdown nodes (same pattern as
`gofa-motor`/`gofa-rapid-exec`). If a flow made with 1.x shows "unknown node" after upgrading,
replace the old node with its successor and pick the action:

| Old node (removed) | Replace with | Action setting |
|---|---|---|
| `gofa-leadthrough-enable` | `gofa-leadthrough` | `enable` |
| `gofa-leadthrough-disable` | `gofa-leadthrough` | `disable` |
| `gofa-points-export` | `gofa-points` | `export` |
| `gofa-points-import` | `gofa-points` | `import` |
| `gofa-file-read` | `gofa-file` | `download` |
| `gofa-upload-mod` | `gofa-file` | `upload` |

Behavior, payload overrides, and outputs are unchanged per action; `gofa-file` also gains a new
`delete` action. The bundled example flows are already migrated.

## What's in this repo

```
node-red-contrib-abb-gofa/       ← Node-RED palette (npm installable: node-red-contrib-abb-gofa)
rapid/
  MainModule.mod                 ← RAPID socket server (must run on controller) — the default
  MainModuleEGM.mod              ← Optional sibling: adds EGM streaming support (see EGM section)
  BackgroundLed.mod               ← Optional: separate-task background server (LED + digital-output writes), survives T_ROB1 being stopped
flows/
  gofa_demo_flow.json            ← Demo flow — one inject per node, includes the EGM module-load + streaming demo (see EGM section)
  setup_flow.json                ← One-click first-run setup flow
  pickplace_sorting_flow.json    ← Pick-and-place sorting cell example
  teach_workflow_flow.json       ← Physical-button teach workflow (see below)
  watchdog_flow.json             ← Self-healing socket-wedge watchdog — see the "Module version handshake + watchdog flow" section in CLAUDE.md
MANUAL_CONTROL.md                ← Control the robot directly (curl / raw TCP), no Node-RED needed
```

---

## Requirements

- ABB GoFa 12 (CRB 15000-12/1.27) with OmniCore C30 controller
- RobotWare 7.x (tested live on `7.21.0+229`, which runs RWS 2.0 — path-based actions, not the IRC5-era `?action=` query form)
- Node-RED v3+ (tested on 5.0.1)
- Node.js v18+ (tested on v22.9.0)
- RobotStudio (free) — needed once for user permission setup, and again if you ever need to change an I/O signal's Access Level (tested with RobotStudio 2026.2)

No extra RobotWare options required. RWS (Robot Web Services) is built into every OmniCore controller. An I/O expansion board (e.g. DSQC1030 Scalable I/O) is only needed if you want general-purpose digital I/O beyond the built-in safety/system signals — see [Files and I/O](#files-and-io).

---

## Quick start

> **One-click setup (recommended).** Steps 1 and 3 below can be fully automated:
>
> 1. [Create an RWS user with Remote Start/Stop permission](#2-create-an-rws-user-robotstudio) (RobotStudio — one time)
> 2. [Install the Node-RED palette](#4-install-the-node-red-palette)
> 3. Import `flows/setup_flow.json`, open the robot config node, enter the username/password from step 1, and click **Discover** to find the robot's IP on your LAN (or type it in)
> 4. Put the controller in **Auto** mode on the FlexPendant, then hit the flow's inject
>
> The **gofa-setup** node does the rest: uploads the bundled RAPID module (with its
> `SERVER_IP` auto-synced to the config node's IP), loads it into `T_ROB1`, resets the
> program pointer, turns motors on, starts RAPID, and confirms the socket server answers —
> with a per-step report so a failure tells you exactly what to fix. The manual steps below
> remain as the reference for doing any of it by hand.

1. [Set your robot's IP address](#1-set-your-robot-ip) (if different from `192.168.20.33`)
2. [Create an RWS user with Remote Start/Stop permission](#2-create-an-rws-user-robotstudio)
3. [Upload and run the RAPID program](#3-upload-and-run-the-rapid-program)
4. [Install the Node-RED palette](#4-install-the-node-red-palette)
5. [Configure the robot config node](#5-configure-the-robot-config-node)

---

## 1. Set your robot IP

If your robot's IP address is **not** `192.168.20.33`, you need to update it in three places before doing anything else.

### Find your robot's IP

On the **FlexPendant**: ABB menu → **Control Panel** → **Network Settings** — the LAN port IP is shown there.

### Update the repo files

Run this in your terminal from the repo root (replace `X.X.X.X` with your IP):

**Windows (PowerShell):**
```powershell
$old = "192.168.20.33"; $new = "X.X.X.X"
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
| `flows/teach_workflow_flow.json` | Stored IP in the teach workflow config |

> **Why MainModule.mod?** The RAPID socket server explicitly binds to the controller's own IP address. If this doesn't match the actual IP, the socket server silently fails to start and all TCP commands will time out.

---

## 2. Create an RWS user (RobotStudio)

The built-in `Admin` account cannot start or stop RAPID remotely. You need to create a dedicated user with Remote Start/Stop permission. This is a one-time setup done in RobotStudio.

### Open RobotStudio and connect

1. Open **RobotStudio** (free download from ABB)
2. **Controller** tab → **Add Controller** → enter your robot's IP → connect
3. Log in with the controller's admin account when prompted (ABB factory default is `Admin` / `robotics` — change it if you haven't)

### Create a role and assign it to the user

4. Click **Authenticate** in the ribbon and log in with an admin account — UAS edits require this first

   *(If you don't see **Edit User Accounts**: try right-clicking the controller name in the left panel → look for Authorization or User Accounts)*

5. Click **Edit User Accounts**
6. In the **Role** tab → click **Add Role**
7. Set a role name (e.g. `RemoteControl`) → leave the rest as-is → in the **Grants** / **Permissions** list, enable:
   - ✅ **Remote Start** (allows `start` action via RWS)
   - ✅ **Remote Stop** (allows `stop` and `resetpp` actions via RWS)
   - ✅ All other grants you want (read-only operations work without grants)
8. Switch to the **User** tab → either change an existing user's role to the one you just created, or click **Add User** to create a new user (e.g. `nodeuser` with a password of your choice) and assign it the new role
9. Click **OK** → **Apply**

> **What about `resetpp`?** It requires edit mastership in addition to Remote Stop — the palette handles this automatically using `/rw/mastership/edit/request`.

### Update the palette credentials

No source edits needed — enter the username and password you just created in the **gofa-robot** config node (Step 5). If you import the example flows from `flows/`, open their `gofa-robot` config node and update the credentials there too.

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

1. **Load the module**: **Home** → **Code** → **⋮** (top right) → **Load Module** → navigate to `/HOME/Programs/` → set the file type filter (bottom right) to `.mod` → `MainModule.mod` appears → select it → **Load** (top right) → back to **Home**
2. **Set Main and check the program**: **Code** → **☰** (hamburger, top left) → **Modules** → select `MainModule` → select `main` → show-menu button (right) → **Check Program** → **Debug** → **PP to Main**
3. **Start**: **⋮** (top right) → **Control** → **Auto** → **Motors on** → **Play** (▶)

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

This package is published on npm — install it directly, or via **Menu → Manage palette →
Install** inside the Node-RED editor and search for `node-red-contrib-abb-gofa`:

```bash
cd ~/.node-red
npm install node-red-contrib-abb-gofa
```

Restart Node-RED. The **ABB GoFa** section will appear in the palette sidebar.

### Installing from a local checkout instead (contributing / pre-release changes)

If you're working from a clone of this repo rather than the published package (e.g. testing an
unreleased change):

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-abb-gofa/node-red-contrib-abb-gofa
```

> **Note (local install):** npm 7+ creates a symlink instead of copying. The palette depends on the `ws` package — run `npm install` once inside the palette directory to make sure it resolves correctly:
> ```bash
> cd /path/to/node-red-contrib-abb-gofa/node-red-contrib-abb-gofa && npm install
> ```

---

## 5. Configure the robot config node

Every GoFa node shares a single **gofa-robot** config node. Open any GoFa node → click the pencil icon next to **Robot**:

| Field | Default | Description |
|-------|---------|-------------|
| Robot IP | `192.168.20.33` | Controller IP — must match Step 1 |
| RWS Port | `443` | HTTPS port (built-in, do not change) |
| Socket Port | `1025` | TCP port for the RAPID socket server |
| Background Services Port | `1026` | Optional — port for `BackgroundLed.mod`'s separate task (LED + digital-output writes that survive T_ROB1 being stopped) |
| Username | `Default User` | The user you created in Step 2 |
| Password | *(empty)* | The password you set in Step 2 |
| Points File | `points.json` | Saved robot positions on the Node-RED host |
| Remote Points Path | `$HOME/Programs/gofa_points.json` | Used instead of Points File when a point node's Storage is set to On-Robot |

Click **Update** → **Deploy**.

---

## Import the demo flow

**Menu → Import → select a file:**

| Flow | What it does |
|------|-------------|
| `flows/gofa_demo_flow.json` | One inject per node — good for testing each feature; includes a "4 - EGM (UDP)" group that loads `MainModuleEGM.mod` and streams (see [EGM](#egm-externally-guided-motion)) |
| `flows/setup_flow.json` | One-click first-run setup (`gofa-setup`) |
| `flows/pickplace_sorting_flow.json` | Pick-and-place sorting cell example |
| `flows/teach_workflow_flow.json` | Physical-button teach workflow (see below) |
| `flows/watchdog_flow.json` | Self-healing socket-wedge watchdog — polls every 30s, auto-recovers a genuinely stuck RAPID socket, leaves teach workflow / EGM sessions alone |

After importing, open the **gofa-robot** config node (click any GoFa node → pencil icon) and verify the IP and credentials match your setup.

---

## Teach workflow (physical ASI buttons)

`flows/teach_workflow_flow.json` is a standalone flow — its own tab, its own copy of the
`gofa-robot` config node (same `cfg1` id as the demo flow, so importing both is safe; Node-RED
de-dupes config nodes by id). It uses the two physical buttons on the GoFa's arm
(`Asi1Button1`/`Asi1Button2` — plain digital signals, readable/subscribable regardless of what
the FlexPendant's Wizard menu has them assigned to) to hand-guide the arm without touching the
FlexPendant at all:

**Precondition: robot already in Auto mode, Motors On, RAPID running** — this flow doesn't set
that up, it assumes it and checks for it.

1. **Press Button 1** — stops RAPID, confirms it actually reached the stopped state (bounded
   live poll, not a fixed guess-and-hope delay), then enables lead-through. The ASI status
   light turns solid yellow as a physical "teach mode active" cue — no screen needed. (Yellow
   was chosen deliberately: it's the same color the safety controller's own motion-override
   uses while the arm is actually being moved, so the LED doesn't visibly change color between
   "idle" and "moving" during the session — one steady color throughout.)
2. Hand-guide the arm.
3. **Press Button 2** (any time while lead-through is active) — saves the current pose as a new
   point (written to the robot controller's own disk by default, not the Node-RED host's local
   `points.json` — see `gofa-save-point`'s Storage option), and the ASI light flashes yellow
   twice as a physical "saved" confirmation, then returns to solid yellow immediately. Pressing
   it while *not* in teach mode is safely ignored with a clear message instead of silently
   saving an unintended pose (the LED doesn't flash in this case either — an implicit "nothing
   happened" cue).
4. **Press Button 1 again** — disables lead-through, resets the program pointer, restarts
   RAPID — back to exactly the state before step 1, including the ASI light resetting to its
   normal solid-green RAPID-running state.

> Both button-watcher branches insert a short settle delay (2s on Button 1, 3s on Button 2)
> between "start watching" and actually subscribing over WebSocket — on a Node-RED restart, a
> subscribe request fired before the robot's RWS session is ready gets rejected with
> `WebSocket upgrade rejected: HTTP 500`; the delay avoids racing that.

> **LED feedback requires a one-time controller setup.** RAPID (and its socket server) is
> stopped for the entire hand-guiding session, so the three `gofa-asi-led` nodes in this flow
> use the `background` transport — `BackgroundLed.mod` running in its own RAPID task, alongside
> `T_ROB1`, so it keeps answering even while `T_ROB1` is stopped. This needs `BackgroundLed.mod`
> uploaded and assigned to a second task (RobotWare Multitasking) before the lights will work —
> see `CLAUDE.md`'s "Background LED task" section for the exact one-time RobotStudio steps.

Every press re-reads live robot state (`gofa-status`) to decide what to do rather than trusting
an internal flag, so it's self-healing across a Node-RED restart mid-session. Every multi-step
sequence is gated on the previous step's success (a failed RAPID stop won't blindly proceed into
enabling lead-through, etc.) and every step's result is visible in its own debug output — check
the debug sidebar if a press doesn't seem to do anything. Every producing node in this flow has
**Output payload** enabled (unlike this package's other example flows, which leave it off by
default) since the flow's own routing logic depends on reading the real `msg.payload` at every
step, not just on the debug sidebar being useful.

---

## Nodes reference

Protocol key: **TCP** = RAPID socket server port 1025 · **RWS** = HTTPS REST API port 443 · **WS** = RWS WebSocket · **Local** = no network (`points.json` on Node-RED host)

### Read robot state

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-status** | RWS | Controller state, op-mode, speed %, RAPID exec state |
| **gofa-connection-status** | RWS + TCP | Per-layer health check (RWS calls + socket ping reported independently) — never raises a Node-RED error on failure, so it's safe to poll on a timer. Also reports each ping's module version vs. this palette's own, and whether a `gofa-egm` session is active |
| **gofa-pose** | RWS | TCP position (x, y, z mm + quaternion + config flags) |
| **gofa-joints** | RWS | All 6 joint angles in degrees |
| **gofa-system-info** | RWS | RobotWare version, controller name/ID/MAC |
| **gofa-elog** | RWS | Controller event log — Domain (category, e.g. Safety/Motion/RAPID) and Min Severity (info/warning+/error-only) filters |

### Motion

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-motor** | RWS | Motors on / off |
| **gofa-speed-set** | TCP | Speed override 1–100% |
| **gofa-move** | TCP | HOME (go to home) or SETHOME (save current pose as home) |
| **gofa-movej** | TCP | Absolute joint move `[j1..j6]` degrees ("Move Joints") — Move type: Joint (default) or Linear straight-line TCP path |
| **gofa-jog** | TCP | Relative TCP translate (mm, base frame) or rotate (°, tool frame) |
| **gofa-joint-jog** | TCP | Rotate single joint by ± degrees |
| **gofa-zone-set** | TCP | Path blend zone (fine / z1 / z5 / z10 / z20 / z50 / z100) |
| **gofa-stop-motion** | TCP | Halt motion — immediate for a jog in progress; for `HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL` it takes effect once the current move finishes (those stopped using `\Conc` in 2.4.2 — see CLAUDE.md) |
| **gofa-ping** | TCP | Round-trip latency test |
| **gofa-grip** | RWS | Digital output on/off for a gripper (same mechanism as `gofa-do-write`, with a preconfigured signal name + friendly on/off/true/false/gripon/gripoff input) |
| **gofa-leadthrough** | TCP + RWS | Hand-guiding on/off — action `enable` (sends STOP to clear queued moves, but only if RAPID is genuinely still running — skipped if it's already stopped, avoiding a ~5s wasted timeout) or `disable` |
| **gofa-asi-led** | TCP | Set ASI status light RGB color (`0–255`) and blink; supports counted software blink |

### Saved points

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-save-point** | RWS + Local/RWS | Read current pose, save as named point in `points.json` (Local) or a JSON file on the robot's own disk (On-Robot) |
| **gofa-go-point** | TCP + Local/RWS | Look up a saved point and move to it — move type (Joint/MoveJ or Linear/MoveL) selectable |
| **gofa-point-list** | Local/RWS | Output the full saved-points array |
| **gofa-delete-point** | Local/RWS | Remove a saved point by name |
| **gofa-points** | Local | Action `export` (dump list to `msg.payload`, optionally to a file) or `import` (**replaces** the whole list from `msg.payload` or a file) — local storage only |
| **gofa-sequencer** | TCP + Local/RWS | Visit saved points in order — per-step dwell + move type override, loop count, ping-pong, startStep |
| **gofa-stop-seq** | TCP + Local | Stop sequencer immediately (sends `STOP` socket + sets flag) |

> **Storage: Local vs On-Robot.** All five point nodes above (save/go/list/delete/sequencer) have a **Storage** option — **Local** (default) uses `points.json` on the Node-RED host, same as always. **On-Robot** stores the identical point data in a JSON file on the robot controller's own disk instead — the `gofa-robot` config node's **Remote Points Path** (default `$HOME/Programs/gofa_points.json`) — managed purely over RWS `fileservice` `GET`/`PUT` (the same mechanism `gofa-file` uses), so **no local file is needed on the Node-RED host**. `msg.payload.storage` (`"local"`/`"remote"`) overrides the node's configured Storage per-message. Movement is unaffected either way — only where the point *data* is looked up changes; `gofa-sequencer` fetches the whole On-Robot list once per run, not once per step. No concurrent-write protection on the On-Robot file (unlike Local's changed-on-disk check) — fine for a human-paced "teach a point" workflow.
>
> This was originally going to live inside `MainModule.mod`/RAPID itself, but RAPID's `string` type has a hard 80-character limit (see the move-type note below) that a growing list of named points would quickly exceed — storing it as a file managed entirely over RWS sidesteps that completely, since it's plain HTTP with no RAPID `string` involved.

> **Move type — Joint (MoveJ) vs Linear (MoveL):** `gofa-go-point` and `gofa-sequencer` let you pick how the robot reaches a saved point. **Joint (MoveJ)** is joint-interpolated and is the default whenever a move type isn't set or an invalid value is passed — it's the more predictable/reliable choice because RAPID has freedom in how each axis gets there, so it won't fault or slow drastically near a singularity. **Linear (MoveL)** forces a straight-line TCP path, which is useful for a controlled approach/retract near a workpiece but can hit a singularity or joint limit along that line even when both endpoints are fine on their own.

### RAPID program control

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-setup** | RWS + TCP | One-click first-run initialization: upload the bundled `.mod` (SERVER_IP auto-synced) → load → reset PP → motors on → start → socket PING (also checks the module's version against this palette's), with a per-step report. See [Quick start](#quick-start) |
| **gofa-rapid-exec** | RWS | `start` / `stop` / `resetpp` / `loadmod` / `unloadmod` / `activate` the RAPID program |
| **gofa-rapid-var-read** | TCP + RWS | Read a RAPID PERS variable via `GETVAR:<name>` socket command; falls back to a stale RWS module-text read if the variable isn't allow-listed |
| **gofa-rapid-var-write** | TCP | Write a RAPID PERS variable via `SETVAR:<name>:<value>` socket command — no RWS fallback exists (see below) |
| **gofa-rapid-tasks** | RWS | List RAPID tasks on the controller and the modules loaded in one of them |

> `gofa-rapid-exec` requires the RWS user to have **Remote Start** and **Remote Stop** grants (see Step 2). `resetpp`, `loadmod`, `unloadmod`, and `activate` additionally acquire edit mastership automatically.
>
> `loadmod` reloads a module file already on the controller's disk into a task — the RWS equivalent of the FlexPendant's **Load Module** step (see [Load and start on the FlexPendant](#load-and-start-on-the-flexpendant)). Use it after a **gofa-file** upload to make a running task pick up a changed `.mod` file without touching the FlexPendant. `activate` makes a named module the task's active/bound one — confirmed working but only needed if you must explicitly (re)bind a module by name; the common "edit and re-upload `MainModule.mod`" workflow only needs `loadmod`.
>
> **`unloadmod` removes a module from the task without touching the file on disk.** Necessary before `loadmod`-ing a *differently-named* module — `loadmod`'s `replace` option only replaces a module with the **same name**, so loading e.g. `MainModuleEGM` while `MainModule` is still loaded leaves **both** loaded. Since both declare `PROC main()`, RAPID then rejects `resetpp`/`start` with `(87,5): Global routine name main ambiguous` — confirmed live building the [EGM](#egm-externally-guided-motion) feature. Swap sequence either direction: `stop` → `unloadmod` (whichever module is currently loaded) → upload the other file → `loadmod` → `resetpp` → `start`.
>
> **`loadmod`, `unloadmod`, and `activate` all require RAPID to be stopped** — confirmed live: all three return HTTP 403 ("Operation not allowed for current PGM state") while RAPID is running. Stop RAPID first (`stop`), run `loadmod`/`unloadmod`/`activate`, then `start` again — with `resetpp` in between if the program pointer also needs resetting to Main.

> `gofa-rapid-var-read` / `gofa-rapid-var-write` use the TCP socket and work on standard OmniCore C30 without any extra RobotWare options. The variable must be listed in `TryGetVar` / `TrySetVar` in `MainModule.mod`. Built-in test variables: `nTestVar` (num) and `sTestMsg` (string). See [Adding RAPID variables](#adding-rapid-variables) below.
>
> **Why not a generic RWS variable read/write node?** RWS has a generic endpoint that can read/write any RAPID variable without editing RAPID code, but it 404s on this controller (`SYS_CTRL_E_UNRESOLVED_URL`) — not because of a missing license (that was checked and ruled out against ABB's own product manual). **Confirmed impossible on this controller, not just unworked-out**: ABB's own current documented `search-symbols` call (exact method/path/params, fetched live from their Developer Center) was reproduced verbatim against the real controller (RobotWare 7.21.0+229) and still fails — `POST /rw/rapid/symbols?action=search-symbols` returns `405 Method Not Allowed` even though the response's own `Allow` header claims POST is valid; every other path/method variant tried 404s or returns silently empty. See the `abb-rws` skill for the full investigation. The socket-based approach above is proven and needs no extra license, at the cost of having to allow-list each variable in `MainModule.mod`. Because there's no working RWS write endpoint at all, `gofa-rapid-var-write` has no fallback path the way `gofa-rapid-var-read` does — the only RWS-adjacent alternative (re-uploading the whole module with a new literal default via `gofa-file`) changes the compiled declaration, not the live value, and needs RAPID stopped and the program pointer reset to take effect, so it isn't a real substitute for a live write.
>
> **Reading a variable that isn't allow-listed:** `gofa-rapid-var-read` and `gofa-subscribe-var` fall back to reading the module's source text off the controller and regex-matching `name := value` for variables not in `TryGetVar`. **Confirmed live against a real controller that this fallback is stale** — it returns the compiled/declared value, not the variable's current runtime value (writing a new value via `SETVAR` and re-reading through this path still shows the old one). Both nodes mark it `stale: true` with a `warning` field rather than presenting it with the same confidence as a live socket read. For a genuinely live value, add the variable to `TryGetVar` instead.
>
> `gofa-rapid-tasks` is a plain read (no mastership needed) — useful for confirming what's actually loaded/running on the controller, e.g. after an upload or when a socket command mysteriously times out.

### Files and I/O

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-file** | RWS | Controller filesystem — action `download`, `upload` (local path in properties or via `msg.payload`; auto-syncs `SERVER_IP`), or `delete` (new in 2.0.0) |
| **gofa-mod-edit** | RWS | Edit a `.mod` (or any text) file on the controller's disk in the node's edit dialog — dropdown of files in `$HOME/Programs` (or a new filename), **Load from robot** / **Save to robot** buttons, `SERVER_IP` auto-synced on save; an input message re-uploads the stored content |
| **gofa-io-list** | RWS | List all I/O signals |
| **gofa-di-read** | RWS | Read a digital input (0 or 1) |
| **gofa-do-write** | RWS, TCP, or Background task | Write a digital output (0 or 1) — **Transport** dropdown: RWS `/set-value` (default), Socket `SETDO` (needs T_ROB1 running), or Background task (same `SETDO`, via `BackgroundLed.mod`'s own task — works while T_ROB1 is stopped) |

> **Writing a digital output needs the signal's Access Level set to `All` — unless you use the Socket or Background transport instead.** RWS writes go through `POST /rw/iosystem/signals/{name}/set-value` — this only succeeds if the target signal's `Access` config attribute is `All` (RobotStudio: `Controller` → `Configuration` → `I/O System` → `Signal` → `Access Level`; requires a controller restart to take effect). Left at the factory default (`Rapid|LocalManual`), the write correctly fails with `403`. **The action name matters too**: the IRC5/RWS-1.0-documented `/set` path 405s unconditionally on OmniCore/RWS 2.0, regardless of Access Level — `/set-value` is the real OmniCore action (see the [405 troubleshooting entry](#rws-returns-405-method-not-allowed) below). This project has no analog I/O (`gofa-ai-read`/`gofa-ao-write` were removed) — the standard OmniCore C30/CRB 15000 combo has no native analog port; ABB's `DSQC1032` Analog Add-On module (attaches to an existing digital Scalable I/O base device) would be needed to add one.
>
> **`gofa-do-write`'s Socket transport** sends the write over the TCP socket instead of RWS — RAPID's `SetDO` against an explicit per-signal allow-list in `MainModule.mod` (`ABB_Scalable_IO_0_DO1`–`DO16`), bypassing the Access Level restriction entirely (RAPID always has access to its own I/O). Needs RAPID actually running. **Gotcha confirmed live**: the signal name is matched **case-sensitively** on this path (RAPID's `DispatchJson`, added in the JSON socket-protocol rewrite, gets the raw name with no `CleanCmd`-style uppercasing) — `gofa-do-write.js` upper-cases the name before sending so this palette's own mixed-case default (`ABB_Scalable_IO_0_DO1`) still works; if you write your own socket call by hand, remember to upper-case the signal name yourself.
>
> **`gofa-do-write`'s Background task transport** is the same `SETDO` mechanism as Socket, but sent to `BackgroundLed.mod` running in its own RAPID task (`T_LED`) instead of `T_ROB1` — it keeps working even while `T_ROB1` is stopped (teach workflow, EGM session). Requires the one-time RobotStudio task setup described in `CLAUDE.md`'s "Background LED task" section.

### Real-time subscriptions

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-subscribe-state** | WS | Push on every controller state change; one-shot mode polls once per inject |
| **gofa-subscribe-io** | WS / poll | Push on every I/O signal change (real WebSocket push); falls back to 500 ms polling only if the subscription request itself fails (e.g. `400`); one-shot mode polls once per inject |
| **gofa-subscribe-var** | RWS poll | Poll a RAPID variable on an interval |
| **gofa-subscribe-pose** | RWS poll | Poll TCP position on an interval |
| **gofa-subscribe-elog** | WS | Push new controller event log entries in real time; same Domain + Min Severity filters as `gofa-elog` |

> **One-shot checkbox** — both `gofa-subscribe-state` and `gofa-subscribe-io` have a **One-shot** option in their properties. When checked, each inject triggers a single poll and returns the current value immediately without opening a persistent subscription.
>
> **Domain filters by category, not severity.** `gofa-elog`/`gofa-subscribe-elog`'s **Domain** dropdown picks an ABB log category (Common, Operational, Safety, Motion, RAPID, …) — it has nothing to do with how severe an entry is. Every entry also has a severity (`msgtype`: info/warning/error) completely independent of its domain; use **Min Severity** to filter on that instead. Want "just the real problems"? Set Min Severity to Warning+ or Error only — picking a domain alone won't filter out info-level noise like "Motors On state."
>
> **`gofa-subscribe-elog`'s WebSocket push only carries a reference**, not the entry itself — the node does one extra RWS `GET` per new entry to fetch its fields before emitting. This is different from `gofa-subscribe-state`/`gofa-subscribe-io`, whose pushes already carry the changed value.

### EGM (Externally Guided Motion)

| Node | Protocol | What it does |
|------|:--------:|-------------|
| **gofa-egm** | Socket + UDP (EGM) | Session control + telemetry — Action dropdown (`start`/`stop`); `start` sends `EGMJOINT` over the TCP socket before switching to UDP, `stop` sets a signal via RWS |
| **gofa-egm-move** | In-memory | Sets the live target if a `gofa-egm` session is active; otherwise routes to a fallback output |

`gofa-egm` streams joint positions over EGM — a UDP/protobuf channel built into RobotWare
(option `3124-1`, standard on OmniCore), capable of sub-10ms closed-loop motion. Everything
else in this palette goes through the TCP socket server or RWS, both of which top out around
100–500ms — EGM is the only path here for real-time control. **Confirmed live** (2026-07-09):
real motion, closed-loop — a `+3°` target on one joint produces a smooth ramp visible in the
returned feedback, converging on the commanded value and back.

**Two nodes, split by job.** `gofa-egm` only starts/stops the session and emits telemetry — it
has an **Action** dropdown (`Start EGM` / `Stop EGM`, same pattern as `gofa-motor`/
`gofa-rapid-exec`: put one node instance per action in a flow, each fed by a plain inject).
`gofa-egm-move` is a separate node that sets the actual movement target: send it a `[j1..j6]`
array and it checks whether a `gofa-egm` session is active on the same Robot — if so, it updates
the live target (**output 1**); if not, it routes the same message unchanged to **output 2**
(fallback) instead of erroring, so you can wire that straight into `gofa-movej` for an automatic
non-EGM move instead.

**This is opt-in and needs its own RAPID module.** `rapid/MainModule.mod` (the default covered
by the rest of this README) has no EGM support. `rapid/MainModuleEGM.mod` is a full clone of
it — identical TCP command server — plus one added command, `EGMJOINT`, that switches the
controller into a blocking EGM session. Only one of the two can be loaded on the controller at
a time.

#### Loading MainModuleEGM.mod

Same as [uploading MainModule.mod](#3-upload-and-run-the-rapid-program), but with one
extra required step. **Switching between the two modules always needs an explicit unload
first** — see the `unloadmod` note under [RAPID program control](#rapid-program-control)
above for why (`loadmod`'s `replace` only replaces a same-named module; skipping the unload
leaves both loaded and RAPID rejects `resetpp`/`start` with an ambiguous-`main` error). Full
sequence, either direction:

1. `gofa-rapid-exec` → `stop`
2. `gofa-rapid-exec` → `unloadmod` (module = whichever is currently loaded, e.g. `MainModule`)
3. `gofa-file` (action upload) → the other file (e.g. `rapid/MainModuleEGM.mod`, remote path
   `$HOME/Programs/MainModuleEGM.mod`)
4. `gofa-rapid-exec` → `loadmod` (module path from step 3)
5. `gofa-rapid-exec` → `resetpp`
6. `gofa-rapid-exec` → `start`

The "0 - Load MainModuleEGM.mod" group inside the "4 - EGM (UDP)" group of
`flows/gofa_demo_flow.json` wires this exact sequence up as a ready-made sub-flow (with `change`
nodes clearing `msg.payload` between chained `gofa-rapid-exec` nodes — see the chaining note in
[msg.payload conventions](#msgpayload-conventions)). If the wrong module ends up loaded anyway,
`gofa-egm`'s `start` action fails with a clear "load MainModuleEGM.mod first" error instead of
hanging.

#### One-time controller setup (RobotStudio, not done by any node)

A UDPUC transmission protocol named `EGM_PC`: **Controller** → **Configuration** →
**Communication** → **Transmission Protocol** → Add — `Name: EGM_PC`, `Type: UDPUC`,
`Remote Address:` the Node-RED host's IP on the robot's subnet, `Remote Port: 6510` (must match
`gofa-egm`'s configured UDP Port). **Requires a controller restart to take effect.** Also
needs a firewall rule on the Node-RED host allowing inbound UDP on that port.

> **`EGM_PC`'s Remote Address drifts the same way the robot's own IP does** (see
> [Set your robot IP](#1-set-your-robot-ip)) — if the Node-RED host's IP changes, `EGM_PC`
> needs updating too, or `gofa-egm`'s `start` will succeed (`OK:EGMJOINT`, UDP binds fine) but
> zero frames will ever arrive. Confirmed live: this looks identical to a firewall problem
> ("No EGM frames received within 2s") — check `EGM_PC`'s configured address first.

> **Caution — tool load data:** per ABB's EGM Application Manual, the robot should have correct
> tool load data (`LoadIdentify`) before starting EGM — incorrect load data can cause servo
> torque overruns or safety halts when EGM issues fast corrections. `MainModuleEGM.mod`'s
> `tGripper` currently uses an unverified placeholder mass (1 kg); confirm it matches your
> actual end-of-arm tooling (or run `LoadIdentify`) before relying on EGM with real tooling
> attached.

#### Input / output

**`gofa-egm`**: `msg.payload` overrides the node's configured Action — a bare `"start"`/`"stop"`
string or `{ action: "start" }` / `{ action: "stop" }`; anything else (including a plain inject's
empty/date payload) just runs the configured Action. Output: `{ ok: true, joints, seqno,
mciState, motorsOn, convergence, source: 'egm' }`, throttled (config option, default 100ms —
real EGM frames arrive every ~24ms).

**`gofa-egm-move`**: `msg.payload` = an array of 6 numbers (absolute joint target, degrees) or
`{ joints: [...] }`. Output 1 (target sent) or output 2 (fallback — EGM session not active)
fires, never both; `msg.payload` is normalized to a bare `[j1..j6]` array on either output.

Full details in each node's Node-RED sidebar help.

**Ending a session is not automatic — always use `gofa-egm`'s `stop` action, don't just stop
sending targets.** EGM's own comm-timeout mechanism does not reliably end a session on its own
(confirmed live: going quiet with a session already connected can leave the controller blocked
for minutes with no recovery). `stop` (or closing/redeploying the `gofa-egm` node while a
session is active) sets a dedicated signal via RWS that a RAPID interrupt watches — the
controller ends the EGM session gracefully (`EGMStop`, from a TRAP) and returns to normal TCP
serving on its own; the RAPID task itself never actually stops, so this is fast (~1s) and
doesn't risk leaking controller-side EGM resources the way an external task-level stop would.

While a session is active, every other socket-based node (`gofa-jog`, `gofa-go-point`, etc.)
fails fast ("connection refused") instead of hanging — the TCP server is genuinely down for
that duration, same as any other time `MainModule.mod`'s socket server isn't running.

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
| **gofa-rapid-exec** | `'start'` / `'stop'` / `'resetpp'` / `'loadmod'` / `'unloadmod'` / `'activate'` (string) · `{ action: 'start' }` · for `loadmod`: `{ action: 'loadmod', task, modulePath, replace }` · for `unloadmod`/`activate`: `{ action: 'unloadmod', task, module }` | `start` |
| **gofa-egm** | `'start'` / `'stop'` (string) · `{ action: 'start' }` | `start` |
| **gofa-egm-move** | array of 6 numbers (absolute joint target, degrees) · `{ joints: [...] }` | (none — required) |
| **gofa-speed-set** | number or string `1`–`100` | `50` |
| **gofa-zone-set** | `'fine'` / `'z1'` / `'z5'` / `'z10'` / `'z20'` / `'z50'` / `'z100'` | `z10` |
| **gofa-grip** | `true` / `1` / `'on'` / `'gripon'` or `false` / `0` / `'off'` / `'gripoff'` · `{ action: 'on' }` | `on` |
| **gofa-jog** | `{ axis, dir, step }` | X, +, 10 |
| **gofa-joint-jog** | `{ joint, dir, step }` | J1, +, 5 |
| **gofa-movej** | `[j1,j2,j3,j4,j5,j6]` or `{ j1, j2, j3, j4, j5, j6 }` | `[0,0,85,0,0,0]` |
| **gofa-go-point** | `{ name, moveType?, storage? }` or `{ id, moveType?, storage? }` — `moveType`: `"J"` or `"L"`, `storage`: `"local"`/`"remote"` | (property) |
| **gofa-save-point** | string (name) · `{ name, storage? }` | (property) |
| **gofa-delete-point** | `{ name, storage? }` or `{ id, storage? }` | (property) |
| **gofa-rapid-var-read** | `{ task, module, variable }` | T_ROB1 / MainModule / (property) |
| **gofa-rapid-var-write** | bare value · `{ variable, value }` | (property) |
| **gofa-rapid-tasks** | `{ task }` — overrides which task's modules to list | T_ROB1 / (property) |
| **gofa-do-write** | `0` or `1` (number) · `{ signal, value, transport }` — `transport`: `'rws'`/`'socket'`/`'background'` | signal: ABB_Scalable_IO_0_DO1, value: 0, transport: rws |
| **gofa-di-read** | signal name (string) | `ABB_Scalable_IO_0_DI1` |
| **gofa-subscribe-io** | `{ signal }` | `ABB_Scalable_IO_0_DI1` |
| **gofa-subscribe-var** | `{ task, module, variable }` (toggles polling) | T_ROB1 / MainModule / (property) |
| **gofa-subscribe-pose** | Toggles on/off each input regardless of payload — starting reads `{ interval }` ms if present; already running always stops, even if a new `interval` is sent | 500 ms |
| **gofa-file** (download/delete) | remote path (string) · `{ remotePath, encoding }` | `$HOME/Programs/MainModule.mod` |
| **gofa-file** (upload) | `Buffer` · local path (string) · `{ localPath, remotePath }` | (property) |
| **gofa-points** (export) | file path (string) · `{ savePath }` | (property / no file) |
| **gofa-points** (import) | file path (string) · `{ loadPath }` · array · `{ points: [...] }` | (property / clear) |
| **gofa-elog** | `{ domain, count, minSeverity }` | domain: 1, count: 10, minSeverity: 1 (all) |
| **gofa-asi-led** | `'red'`/`'green'`/`'yellow'`/`'off'`/etc. · `false`/`0` (off) · `{ color, r, g, b, period, blinkCount, blinkMs }` · `'reset'` (restore default) | node defaults |
| **gofa-sequencer** | `{ steps, dwell, moveType, loop, pingpong, count, startStep, storage? }` — `steps[i].moveType` overrides per-step, `storage`: `"local"`/`"remote"` | (property) |
| **gofa-point-list** | `{ storage }` — `"local"`/`"remote"` | (property) |
| **gofa-io-list** | `{ type }` — optional filter, e.g. `'DI'`/`'DO'`/`'GO'` | (property / all types) |

### Trigger-only nodes (no payload needed)

These nodes fire on any input message and ignore `msg.payload`:

`gofa-status` · `gofa-pose` · `gofa-joints` · `gofa-system-info` · `gofa-ping` ·
`gofa-stop-motion` · `gofa-stop-seq` ·
`gofa-leadthrough` ·
`gofa-subscribe-state` · `gofa-subscribe-elog`

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

### No controller restart/backup nodes

`gofa-restart` and `gofa-backup` nodes were both built and dropped after live testing. ABB documents `POST /ctrl` (body `restart-mode=...`) and `POST /ctrl/backup?action=backup` for these — both reproduced verbatim from ABB's own current docs, and both return a hard `405 Method Not Allowed` on this controller (RobotWare 7.21.0+229), despite `OPTIONS` on each resource listing `Allow: GET,POST,OPTIONS` / `Allow: GET,OPTIONS` respectively. See the `gofa-backup`/`gofa-restart` removed note in `CLAUDE.md` for the full live-test writeup. No working alternative found; a manual restart/backup via the FlexPendant or RobotStudio still works fine.

### Socket commands time out (jog, HOME, ping …)

1. Confirm RAPID is running on the FlexPendant (green play indicator)
2. Check `rapid/MainModule.mod` — `SERVER_IP` must match your robot's actual IP. If you upload via the `gofa-file` node (or `gofa-setup`), this is kept in sync automatically from the `gofa-robot` config node's IP — no manual edit needed.
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
| "Operation not allowed for current PGM state" on `loadmod`/`activate` | RAPID is running | Stop RAPID first (`stop` action), then `loadmod`/`activate`, then `start` again |

### `gofa-rapid-exec` `start` fails with "motors are motoroff"

RAPID error **20055** ("program must start in Motor On state") — RWS accepts the `start`
request with HTTP 200 even when motors are off, so it can't be caught as an HTTP error.
This node checks motor state before sending `start` and reports the real reason instead of
a false `{ ok: true }`. Turn motors on with **gofa-motor** (or the FlexPendant) first. If a
`start` still fails after motors are confirmed on, the payload's `execstate`/`ctrlstate`
fields and **gofa-elog** will show the controller's actual reason.

### `gofa-subscribe-*` shows "unknown node type"

Run `npm install` inside the palette directory so the `ws` package resolves when npm has symlinked the package:

```bash
cd /path/to/node-red-contrib-abb-gofa && npm install
```

Then restart Node-RED.

### Subscribe IO used to always fall back to polling (fixed)

`gofa-subscribe-io` previously requested WebSocket subscriptions with resource suffix `;lvalue`, which OmniCore rejects with `400 Invalid resource URI` for **every** signal — not just ASI ones. The `.catch` on that 400 silently started the 500 ms poll fallback, so this node was never actually using WebSocket push; it was polling for every signal, always. This is fixed as of the commit that changed the suffix to `;state` (the correct fixed resource-type keyword OmniCore expects for I/O signal subscriptions — confirmed live, including on ASI signals like `Asi1Button1`/`Asi1Button2`). If you're on an older build and see it always polling, update.

### `gofa-rapid-exec` `loadmod`/`resetpp`/`start` fails with "Global routine name main ambiguous"

Both `MainModule` and `MainModuleEGM` are loaded on the task at once — `loadmod`'s `replace`
option only replaces a module with the **same name**, so loading one while the other is still
loaded leaves both, and both declare `PROC main()`. Fix: `gofa-rapid-exec` → `unloadmod` for
whichever module you don't want, **before** `loadmod`-ing the other. See
[EGM → Loading MainModuleEGM.mod](#loading-mainmoduleegmmod) for the full sequence.

### `gofa-egm` `start` succeeds but no motion / "No EGM frames received within 2s"

`OK:EGMJOINT` came back and the UDP socket bound fine, but zero frames arrive from the
controller. Almost always a stale `EGM_PC` transmission-protocol config — its **Remote
Address** must be the Node-RED host's *current* IP, which drifts the same way the robot's own
IP does. Check it in RobotStudio (**Controller** → **Configuration** → **Communication** →
**Transmission Protocol** → `EGM_PC`) and restart the controller after fixing it. Also
double-check the firewall rule for inbound UDP on the configured port.

### `gofa-egm` `start` fails with "bind EADDRINUSE 0.0.0.0:6510" (fixed — for older versions)

**Fixed as of the current `gofa-egm`/`gofa-robot`.** Older versions kept the UDP socket as
node-instance-local state while the session flags (`_egmActive` etc.) were shared across
instances — with two separate `gofa-egm` nodes (a "Start EGM" instance and a "Stop EGM"
instance, the documented pattern below), Stop only closed *its own* never-bound socket, leaking
the real one that Start opened. The next "Start EGM" then failed to bind the same port. Fixed by
moving the socket itself onto the shared `gofa-robot` config node too — any `gofa-egm` instance's
stop now closes whichever socket is actually open. If you're on an older version and hit this,
find and kill whatever process is holding the port (`netstat -ano | findstr 6510` on Windows,
`lsof -i :6510` on Linux/macOS) and update.

### `gofa-egm` session won't end / robot stuck unresponsive to TCP nodes after using EGM

Always use the `"stop"` action (or let the node's own redeploy/close handler run) — don't just
stop sending it messages and assume the controller will recover on its own. `gofa-egm`'s
`"stop"` sets a dedicated signal (`ABB_Scalable_IO_0_DO16`) via RWS, which triggers a RAPID
TRAP that ends the EGM session gracefully (`EGMStop`) and returns straight to TCP serving —
the RAPID task itself never stops. If the robot is stuck anyway (e.g. an interrupted Node-RED
process that never got to run its close handler, or a genuinely external stop — FlexPendant,
e-stop — while a session was active), recover manually: `gofa-rapid-exec` → `stop`, then
`resetpp`, then `start` (motors must be on).

### RAPID error "You have to disconnect an EGM instance using EGMReset before you can connect another"

This happens if RAPID is resumed with a plain **continue** start — resuming execution from
wherever the program pointer happened to be — after an EGM session was interrupted by
something *other* than `gofa-egm` itself (FlexPendant Stop, e-stop, module switching). Normal
`gofa-egm` `start`/`stop` cycles no longer stop the task at all, so this shouldn't come up in
everyday use anymore — but if RAPID ever *is* externally stopped mid-session and then resumed
with a bare "continue," the program pointer can be left sitting near/inside the EGM code block;
resuming there re-enters EGM setup without going through `RunEgmJoint`'s own `EGMReset`, which
only runs when execution starts fresh from `main()`.

**Fix**: `gofa-rapid-exec` → `stop`, then `resetpp` (resets the program pointer to the top of
`main()`), then `start`. Rule of thumb: after any *external* interruption while `gofa-egm` was
active, always `resetpp` before the next `start` — a plain "continue" start is only safe when
EGM was never involved.

**If the exact same error still happens after a genuinely fresh `resetpp` + `start`** (check
the controller's event log — it should say "Program started... from the first instruction,"
not "restarted... from where it was previously stopped"), the problem has moved to a stuck EGM
resource at the **controller level** rather than RAPID's program pointer — a full controller
restart is the only fix (EGM/UC state isn't exposed anywhere in RWS, so there's no
lighter-weight recovery). This should be rare now that normal `gofa-egm` usage doesn't
externally kill sessions anymore (see the next entry).

### RAPID error "Too many EGM instances" (fixed 2026-07-09 — informational, for older versions)

**This is fixed as of the current `gofa-egm`/`MainModuleEGM.mod`.** Older versions ended every
EGM session via an external RWS task stop, which skipped `RunEgmJoint`'s own `EGMReset` and
leaked one controller-side EGM instance per cycle — RobotWare allows a maximum of **4**
concurrent EGM identities (per ABB's EGM Application Manual, 3HAC073318), so as few as ~8
cycles could exhaust the pool. The fix, per that same manual: `EGMStop`, called from a RAPID
TRAP, ends a running `EGMRunJoint` *gracefully* instead of via an external kill, so cleanup
runs every time and the instance is actually released. Confirmed live: 12 consecutive
start/stop cycles with stable timing and zero errors, no instance exhaustion.

If you're on an old copy of `MainModuleEGM.mod` (no `TrapEgmStop`/`ISignalDO` in it) and still
see this error: update to the current module (re-run the [load sequence](#loading-mainmoduleegmmod)
with the latest `rapid/MainModuleEGM.mod`) and `gofa-egm.js`. Immediate recovery is unchanged —
a full controller restart is the only way to clear an already-leaked instance pool
(`resetpp`+`start` alone brings RAPID back for plain TCP use, but does **not** reclaim leaked
EGM instances).

### RWS returns 405 (method not allowed)

This palette targets **OmniCore / RWS 2.0** which uses path-based actions (e.g. `/rw/rapid/execution/start`). If you see 405, you may be connecting to an IRC5 controller running RWS 1.0 — the endpoint format is different.

**Specifically for I/O writes**: OmniCore's real action is `POST /rw/iosystem/signals/{name}/set-value` — the IRC5/general-RWS-docs path `/set` 405s unconditionally on OmniCore, on every signal, regardless of Access Level. If you ever hand-roll a curl call against `/rw/iosystem/signals/.../set` and get 405, that's this — use `set-value` instead. `gofa-do-write`/`gofa-grip` both learned this the hard way; see the note under [Files and I/O](#files-and-io) above.

---

## Default connection settings

| Setting | Value |
|---------|-------|
| Robot IP | `192.168.20.33` |
| RWS port | `443` (HTTPS, self-signed cert) |
| Socket port | `1025` |
| Username | `Default User` (set your own in the config node) |
| Password | *(none shipped — set in the config node)* |

The self-signed HTTPS certificate on the controller is accepted automatically (`rejectUnauthorized: false`).
