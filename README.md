# ABB-GoFa-12

Node-RED palette for controlling the **ABB GoFa CRB 15000** collaborative robot over the network — no extra hardware or licenses required.

## What's in this repo

```
node-red-contrib-abb-gofa/   ← Node-RED palette package (npm installable)
flows/
  gofa_demo_flow.json         ← Demo flow showing all nodes
rapid/
  MainModule.mod              ← RAPID socket server (must run on controller)
  GoFaControl.pgf             ← Program loader file
```

---

## Requirements

- ABB GoFa CRB 15000 with OmniCore C30 controller
- RobotWare 7.x (tested on 7.21.0)
- **Socket Messaging / PC Interface** RobotWare option installed
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

| Node | What it does |
|---|---|
| **Robot Status** | Reads controller state, op-mode, speed, RAPID execution state |
| **Read Pose** | Reads current TCP position (x, y, z + quaternion + config) |
| **Read Joints** | Reads all 6 joint angles in degrees |
| **Move Home** | Sends HOME or SETHOME command via socket |
| **Motor On/Off** | Enables or disables robot motors via RWS |
| **Jog** | Moves TCP by a relative step (mm, base frame) or rotates (deg, tool frame) |
| **Joint Jog** | Moves a single joint by a relative angle |
| **Save Point** | Reads current pose and saves it as a named point |
| **Go to Point** | Moves robot to a saved point by name |
| **Point List** | Outputs the full list of saved points |
| **Delete Point** | Deletes a saved point by name |
| **Sequencer** | Runs a list of saved points in order, with dwell time, loop, and back-and-forth options |
| **Stop Sequence** | Signals the sequencer to stop after the current step |

---

## Demo flow

Import `flows/gofa_demo_flow.json` into Node-RED (Menu → Import).  
The flow demonstrates all 13 nodes organized in labeled groups with explanatory comments.

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
