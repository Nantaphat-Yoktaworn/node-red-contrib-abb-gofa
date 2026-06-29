# ABB-GoFa-12

Node-RED palette for controlling the **ABB GoFa CRB 15000** collaborative robot over the network — no extra hardware or licenses required.

## What's in this repo

```
node-red-contrib-abb-gofa/       ← Node-RED palette package (npm installable)
flows/
  gofa_demo_flow.json            ← Demo flow showing all nodes individually
nodered/
  robot_palette_flow.json        ← Full dashboard using only palette nodes
rapid/
  MainModule.mod                 ← RAPID socket server (must run on controller)
  GoFaControl.pgf                ← Program loader file
```

---

## Requirements

- ABB GoFa CRB 15000 with OmniCore C30 controller
- RobotWare 7.x (tested on 7.21.0)
- **PC Interface** RobotWare option *(optional — required only for `gofa-rapid-exec` and `gofa-rapid-var-write`; not included on standard OmniCore C30)*
- **RapidSockets** firewall service enabled on the Public network (RobotStudio → Controller → Configuration → Communication → Firewall Manager)
- Node-RED v3+

---

## Setup — 2 steps

### Step 1 — Load the RAPID program on the controller

Upload `rapid/MainModule.mod` to the controller:

```bash
curl -sk -u Admin:robotics -X PUT -H "Content-Type: text/plain;v=2.0" \
  --data-binary @rapid/MainModule.mod \
  "https://<ROBOT_IP>/fileservice/\$HOME/Programs/MainModule.mod"
```

Then on the **FlexPendant**:
1. Switch to **AUTO** mode and enable motors
2. Program Editor → Load → `$HOME/Programs/MainModule.mod`
3. PP to Main → **Play**

The robot is now listening for commands on port **1025**.

### Step 2 — Install the palette in Node-RED

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-abb-gofa
```

Restart Node-RED. The **ABB-GoFa-12** section will appear in the palette.

---

## Configuration

Open any GoFa node → edit → click the **pencil icon** next to Robot to create a config node:

| Field | Default | Description |
|---|---|---|
| Robot IP | `192.168.20.18` | Controller IP address |
| RWS Port | `443` | HTTPS port for Robot Web Services |
| Socket Port | `1025` | TCP port for the RAPID socket server |
| Username | `Admin` | RWS login |
| Password | `robotics` | RWS password |
| Points File | `points.json` | Where saved points are stored on disk |

---

## Nodes

Protocol key: **TCP** = RAPID socket server port 1025 · **RWS** = Robot Web Services HTTPS port 443 · **WS** = RWS WebSocket subscription · **Local** = no network (reads/writes `points.json` on Node-RED host)

### Read robot state

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-status** | RWS | Controller state, op-mode, speed override, RAPID execution state |
| **gofa-pose** | RWS | TCP position (x, y, z + quaternion + config flags) |
| **gofa-joints** | RWS | All 6 joint angles in degrees |
| **gofa-system-info** | RWS | RobotWare version, controller name, ID, type, MAC |
| **gofa-elog** | RWS | Controller event log entries (domain, count configurable) |

### Motion — TCP socket

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-move** | TCP | HOME (go to saved home) or SETHOME (save current pose as home) |
| **gofa-movej** | TCP | Absolute joint move to target angles `[j1..j6]` in degrees |
| **gofa-jog** | TCP | Move TCP by relative step (mm, base frame) or rotate (deg, tool frame) |
| **gofa-joint-jog** | TCP | Rotate a single joint by a relative angle |
| **gofa-grip** | TCP | Activate (GRIPON) or deactivate (GRIPOFF) gripper via digital output |
| **gofa-zone-set** | TCP | Set path blend radius (fine / z1 / z5 / z10 / z20 / z50 / z100) |
| **gofa-stop-motion** | TCP | Halt current motion immediately |
| **gofa-ping** | TCP | Connectivity test — measures round-trip time to RAPID server |

### Motion — controller

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-motor** | RWS | Enable (motoron) or disable (motoroff) robot motors |
| **gofa-speed-set** | TCP | Set speed override % via RAPID `SpeedRefresh` (no mastership required) |

### Saved points

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-save-point** | RWS + Local | Read current pose via RWS, save as named point in `points.json` |
| **gofa-go-point** | TCP + Local | Look up saved point locally, move robot to it via TCP |
| **gofa-point-list** | Local | Output the full saved-points array |
| **gofa-delete-point** | Local | Remove a saved point by name |
| **gofa-points-export** | Local | Dump entire points list to `msg.payload` (for backup) |
| **gofa-points-import** | Local | Replace points list from `msg.payload` array (for restore) |
| **gofa-sequencer** | TCP + Local | Visit saved points in order with configurable dwell, loop, ping-pong |
| **gofa-stop-seq** | Local | Signal the sequencer to stop after the current step |

### RAPID program

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-rapid-var-read** | RWS | Read a RAPID PERS/VAR value (falls back to fileservice if no PC Interface) |
| **gofa-rapid-exec** | RWS | Start, stop, or reset PP of the RAPID program *(requires PC Interface RobotWare option — not included on standard OmniCore C30)* |
| **gofa-rapid-var-write** | RWS | Write a value to a RAPID PERS variable *(requires PC Interface option)* |

### Files

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-file-read** | RWS | Download a file from the controller filesystem via fileservice |
| **gofa-upload-mod** | RWS | Upload a RAPID `.mod` file to the controller filesystem |

### I/O signals

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-io-list** | RWS | List all I/O signals with name, type, and current value |
| **gofa-di-read** | RWS | Read a digital input signal value (0 or 1) |
| **gofa-ai-read** | RWS | Read an analog input signal value *(requires external I/O module)* |
| **gofa-do-write** | RWS | Write a digital output signal (0 or 1) *(requires external I/O module)* |
| **gofa-ao-write** | RWS | Write an analog output signal (float) *(requires external I/O module)* |

### Lead-through

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-leadthrough-enable** | RWS | Activate hand-guiding (manual mode + enable switch required) |
| **gofa-leadthrough-disable** | RWS | Deactivate hand-guiding |

### Real-time subscriptions

| Node | Protocol | What it does |
|---|:---:|---|
| **gofa-subscribe-state** | WS | Push message on every controller state change (motoron/motoroff/…) |
| **gofa-subscribe-io** | WS | Push message on every I/O signal change |
| **gofa-subscribe-var** | RWS poll | Poll a RAPID variable at a configurable interval; toggle on/off with any input |
| **gofa-subscribe-pose** | RWS poll | Poll TCP position at a configurable interval; toggle on/off with any input |

---

## Example flows

**Demo flow** — `flows/gofa_demo_flow.json`  
Import via Node-RED Menu → Import. Shows all nodes across groups with inject triggers and debug output. Note: `gofa-rapid-exec` is excluded — it requires the PC Interface RobotWare option not present on standard controllers.

**Palette dashboard** — `nodered/robot_palette_flow.json`  
Full robot control dashboard built exclusively with palette nodes. Import it, then open `http://localhost:1880/robot` in a browser. Features: live status, all jog axes, save/go/delete points, sequencer with loop + back-and-forth options.

---

## How movement works

All moves go through the RAPID TCP socket server (port 1025), not the RWS API. This means:

- **No mastership conflicts** — the FlexPendant can stay connected
- **Instant ack** — the robot sends `OK:` before the move starts so the UI stays responsive
- **Automatic recovery** — singularity or out-of-reach errors are caught inside RAPID and don't kill the server

Saved points are stored in `points.json` (on the Node-RED host), not on the robot.

---

## Robot connection test

```bash
printf 'HOME\n' | nc -w 3 192.168.20.18 1025
# Expected: OK:HOME
```
