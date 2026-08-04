# Getting started

This guide takes you from an unconfigured controller to a robot arm that moves on command, and
should take under an hour the first time. At the end you'll have the RAPID socket server running,
the palette installed and configured, and a flow that moves the arm.

**Read the [safety notice](../README.md#-safety-and-security) first.** This software moves a real
robot arm, and Node-RED is not a safety system.

---

## Requirements

- ABB GoFa 12 (CRB 15000-12/1.27) with OmniCore C30 controller
- RobotWare 7.x — it must run **RWS 2.0** (path-based actions, not the IRC5-era `?action=` query form)
- Node-RED ≥ 3.0
- Node.js ≥ 18
- RobotStudio (free) — needed once for user permission setup, and again if you ever need to change an I/O signal's Access Level
- **Optional:** RobotWare Multitasking `[3114-1]` — only if you want the [Background task](reference.md#background-task-backgroundledmod--t_led) (teach workflow's LED feedback while `T_ROB1` is stopped, `gofa-do-write`/`gofa-asi-led`'s Background transport, `gofa-connection-status`'s background health check). Nothing else in this palette needs it.

No extra RobotWare options required for the base feature set. RWS (Robot Web Services) is built into every OmniCore controller. An I/O expansion board (e.g. DSQC1030 Scalable I/O) is only needed if you want general-purpose digital I/O beyond the built-in safety/system signals — see [Files and I/O](reference.md#files-and-io).

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
> with a per-step report so a failure tells you exactly what to fix. If a `T_LED` task
> already exists on the controller (see [Background task](reference.md#background-task-backgroundledmod--t_led)),
> the same click also reloads `BackgroundLed.mod` into it — no extra step. The
> numbered steps below remain the reference for doing any of it by hand.
>
> **Scope: `gofa-setup` sets up `T_ROB1` (the `MainModule`/`MainModuleEGM` pair) plus `T_LED`
> if it already exists.** Every RWS-only and TCP-socket node works after this. `gofa-setup`
> still can't **create** the `T_LED` task itself — that's a one-time, RobotStudio-only step,
> creating a new RAPID task isn't possible over RWS at all (confirmed — see that section) — so
> if you also plan to use the [teach workflow](reference.md#teach-workflow-physical-asi-buttons), or
> `gofa-do-write`/`gofa-asi-led`'s **Background task** transport, or
> `gofa-connection-status`'s background health check, the task itself still needs the separate,
> one-time [Background task setup](reference.md#background-task-backgroundledmod--t_led) once. After
> that one-time setup, `gofa-setup` keeps it updated automatically from then on.

Doing it by hand, in order:

1. [Set your robot's IP address](#1-set-your-robot-ip) (if different from `192.168.125.1`)
2. [Create an RWS user with Remote Start/Stop permission](#2-create-an-rws-user-robotstudio)
3. [Upload and run the RAPID program](#3-upload-and-run-the-rapid-program)
4. [Install the Node-RED palette](#4-install-the-node-red-palette)
5. [Configure the robot config node](#5-configure-the-robot-config-node)
6. [Your first move](#6-your-first-move) — prove each layer works, then move the arm
7. [Import an example flow](#7-import-an-example-flow)

---

## 1. Set your robot IP

The palette's shipped default is `192.168.125.1` — ABB's factory **service port** address, which is
what you get plugging a laptop straight into the controller's service port. A robot on your LAN
almost certainly has a different address.

### Find your robot's IP

On the **FlexPendant**: ABB menu → **Control Panel** → **Network Settings** — the LAN port IP is
shown there. Or click **Discover** in the `gofa-robot` config node to scan the local subnet for
controllers, and use `check-status.js --discover` for the same scan from a terminal.

### Where the IP has to be set

**One place: the `gofa-robot` config node** ([Step 5](#5-configure-the-robot-config-node)). Every
node shares it, and nothing else needs editing for the palette itself to work.

`SERVER_IP` inside `rapid/MainModule.mod` also has to match the controller — the RAPID socket
server binds that address explicitly, and a mismatch means it silently fails to start and every
TCP command times out. **You don't normally edit this by hand**: `gofa-setup` and `gofa-file`
(action *upload*) rewrite `SERVER_IP` from the config node's IP on every upload. Only edit the
file yourself if you're uploading it manually with `curl` (see
[Step 3](#3-upload-and-run-the-rapid-program)).

The example flows in `flows/` each embed their own `gofa-robot` config with a stored IP that
won't match your robot — after importing one, open its config node and correct the IP and
credentials. That's a per-import step, not a repo-wide edit.

> **The robot's IP drifts.** On a DHCP lab network it can change subnet entirely between sessions.
> If everything worked yesterday and every node now times out, re-check the IP before anything
> else — and re-run `gofa-setup` afterwards so the module's `SERVER_IP` is rewritten to match.

---

## 2. Create an RWS user (RobotStudio)

The built-in `Admin` account cannot start or stop RAPID remotely. You need to create a dedicated user with Remote Start/Stop permission. This is a one-time setup done in RobotStudio.

### Open RobotStudio and connect

1. Open **RobotStudio** (free download from ABB)
2. **Controller** tab → **Add Controller** → enter your robot's IP → connect
3. Log in with the controller's admin account when prompted (ABB factory default is `Admin` / `robotics` — change it if you haven't)

### Create a role and assign it to the user

4. **Controller** tab → **Authenticate** → log in with an admin account — UAS edits require this first
5. Click **Edit User Accounts**
6. **Roles** tab → either click **Add Role** to create a new one, or select an existing role and
   click **Edit Role** to modify it
7. Set a role name (e.g. `RemoteControl`) → leave the rest as-is → in the **Grants** /
   **Permissions** list, check:
   - ✅ **Remote Start** (allows `start` action via RWS)
   - ✅ **Remote Stop** (allows `stop` and `resetpp` actions via RWS)
   - ✅ All other grants you want (read-only operations work without grants)
8. **Apply**
9. Switch to the **Users** tab → either change an existing user's role to the one you just created, or click **Add User** to create a new user (e.g. `nodeuser` with a password of your choice) and assign it the new role
10. Click **OK** → **Apply**

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

Restart Node-RED. The **ABB-GoFa-12** section will appear in the palette sidebar.

### Installing from a local checkout instead (contributing / pre-release changes)

If you're working from a clone of this repo rather than the published package (e.g. testing an
unreleased change):

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-abb-gofa/node-red-contrib-abb-gofa
```

> **Note (local install):** npm 7+ creates a symlink instead of copying, which is normally fine —
> the palette has **no runtime dependencies** (the WebSocket client for RWS subscriptions is
> hand-rolled in `nodes/lib/ws.js`), so there is nothing to resolve from `node_modules`.

---

## 5. Configure the robot config node

Every GoFa node shares a single **gofa-robot** config node. Open any GoFa node → click the pencil icon next to **Robot**:

| Field | Default | Description |
|-------|---------|-------------|
| Robot IP | `192.168.125.1` | Controller IP — see [Step 1](#1-set-your-robot-ip). The default is ABB's factory service-port address |
| RWS Port | `443` | HTTPS port (built-in, do not change) |
| Socket Port | `1025` | TCP port for the RAPID socket server |
| Background Services Port | `1026` | Optional — port for `BackgroundLed.mod`'s separate task (LED + digital-output writes that survive T_ROB1 being stopped) |
| Username | `Default User` | The user you created in Step 2 |
| Password | *(empty)* | The password you set in Step 2 |
| Remote Points Path | `$HOME/Programs/gofa_points.json` | JSON file on the **controller's own disk** where `gofa-points`/`gofa-sequencer` store saved positions |
| Joint Limits | *(empty)* | Optional — JSON array of six `[min, max]` pairs enforced by `gofa-movej`. Empty uses the CRB 15000-12/1.27 hardware working range |
| Allow insecure live control | unticked | Re-enables the editor's live-action buttons on an instance with no `adminAuth` — see [Safety and security](../README.md#-safety-and-security) |

Click **Update** → **Deploy**.

---

## 6. Your first move

Everything is configured — this section proves it works, one layer at a time. Do it in order: each
step only needs the layers below it, so the first thing that fails tells you exactly where the
problem is.

> **Before you start:** clear the space around the arm, put the controller in **Auto**, and keep the
> physical emergency stop within reach. The arm will move in step 4.

**1. Is RWS reachable?** Drag an **inject** node and a **gofa-status** node onto the canvas, wire
them together, add a **debug** node on the output, and tick **Output payload (debug)** in the
`gofa-status` node's properties (it's off by default, so the node stays quiet in real flows).
Deploy, click the inject button.

The debug sidebar should show something like:

```json
{ "ctrlstate": "motoroff", "opmode": "AUTO", "speedratio": 100, "execstate": "stopped" }
```

If this fails, nothing else will — it's the credentials and IP from steps 1, 2 and 5. Go to
[RWS returns 401](troubleshooting.md#rws-returns-401).

**2. Is the socket server reachable?** Replace `gofa-status` with **gofa-ping** and inject again.
You should get a round-trip time back, typically a few milliseconds:

```json
{ "ok": true, "rtt": 4 }
```

A timeout here means RWS works but RAPID doesn't — the module isn't running, or its `SERVER_IP`
doesn't match. See [Socket commands time out](troubleshooting.md#socket-commands-time-out-jog-home-ping-).

**3. Turn the motors on.** Add a **gofa-motor** node with Action `motoron`, inject, and confirm the
FlexPendant shows Motors On. Re-run step 1 — `ctrlstate` should now read `motoron`.

**4. Move the arm.** Add a **gofa-jog** node, set **Target** to `Z`, **Direction** to `+`, and
**Step** to `10` (millimetres — small on purpose). Inject once.

The arm should lift 10 mm. Set Direction to `-` and inject again to put it back.

That's the whole loop: an inject triggers a node, the node talks to the robot over RWS or the
socket, and the result comes back on `msg.payload`. Every other node in the palette follows the
same shape.

**If nothing moved but you got no error**, the likely causes in order: the controller isn't in Auto
mode, motors aren't on (step 3), or RAPID isn't running (step 2 would have failed too).

### Where to go next

- **[Import an example flow](#7-import-an-example-flow)** — see the nodes used in a real flow.
- **[Node reference](reference.md)** — what every node does and what payload it accepts.
- **[Saving positions](reference.md#saved-points)** — teach the robot named points and replay them.

---

## 7. Import an example flow

**Menu → Import → select a file:**

| Flow | What it does |
|------|-------------|
| `flows/gofa_demo_flow.json` | One inject per node — good for testing each feature; includes a "4 - EGM (UDP)" group that loads `MainModuleEGM.mod` and streams (see [EGM](reference.md#egm-externally-guided-motion)) |
| `flows/setup_flow.json` | One-click first-run setup (`gofa-setup`) |
| `flows/pickplace_sorting_flow.json` | Pick-and-place sorting cell example |
| `flows/teach_flow.json` | Physical-button teach workflow (see below) |
| `flows/watchdog_flow.json` | Self-healing socket-wedge watchdog — polls every 30s, auto-recovers a genuinely stuck RAPID socket, leaves teach workflow / EGM sessions alone |
| `flows/mqtt_bridge_flow.json` | Publishes state/pose/io onto MQTT topics via core `mqtt out` nodes |
| `flows/egm_conveyor_demo_flow.json` | EGM conveyor-tracking demo — a simulated moving target (no real conveyor/encoder) streamed into an active EGM session, illustrating the real-world pattern; requires `MainModuleEGM.mod` loaded (see [EGM](reference.md#egm-externally-guided-motion)) |
| `flows/brake_check_reminder_flow.json` | Watches the event log for the controller's Cyclic Brake Check warning and surfaces it. Read-only — it detects the reminder, it does not run the brake check |

After importing, open the **gofa-robot** config node (click any GoFa node → pencil icon) and verify the IP and credentials match your setup.

---

