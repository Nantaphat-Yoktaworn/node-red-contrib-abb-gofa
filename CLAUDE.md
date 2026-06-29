# ABB GoFa CRB 15000 — Claude Code Context

Custom Node-RED palette (`node-red-contrib-abb-gofa`) for controlling an ABB GoFa CRB 15000 collaborative robot over a local network. No extra ABB licenses required.

## Skills available

- `/abb-rws` — full RWS API reference (endpoints, auth, response parsing)
- `/omnicore-c30` — OmniCore C30 controller specs
- `/crb15000` — GoFa arm specs, joint limits, working range

## Architecture — two communication layers

**TCP Socket (port 1025)** — motion commands. The RAPID program (`rapid/MainModule.mod`) runs a socket server on the controller. Each Node-RED node opens a fresh TCP connection, sends one newline-terminated command, reads one `OK:<CMD>` or `ERR:<CMD>` reply, and closes.

**RWS HTTPS (port 443)** — telemetry and motor control. REST API built into OmniCore. Auth is Basic on first request → cookie thereafter (auto-refresh on 401). All RWS calls go through `rwsGet()`/`rwsPost()` helpers in `gofa-robot.js`. Responses are XHTML; values extracted with `parseXhtml(body, className)`.

Rule: **motion always goes through the socket; read-only data and motor control go through RWS.**

## RAPID socket protocol

| Command | What it does |
|---------|-------------|
| `HOME` | Move to home position |
| `SETHOME` | Capture current pose as home, persist to `HOME:/Programs/gofa_home.cfg` |
| `GOTOx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose (11 `;`-separated numbers) |
| `X+20` / `Y-10` / `Z+5` | Translate TCP ±mm in base frame (max 50 mm) |
| `RX+5` / `RY-10` / `RZ+15` | Rotate TCP ±° in tool frame (max 30°) |
| `J1+10` / `J3-5` | Jog single joint ±° (max 30°, joints 1–6) |
| `SPEED50` | Set speed override 1–100% |
| `MOVEJ<j1;j2;j3;j4;j5;j6>` | Absolute joint move in degrees |
| `ZONE<name>` | Set path blend zone (FINE / Z1 / Z5 / Z10 / Z20 / Z50 / Z100) |
| `STOP` | Halt motion immediately |
| `PING` | Connectivity test |
| `GRIPON` / `GRIPOFF` | Gripper control via digital output |

Ack is sent **before** the motion starts. RAPID error handler (StopMove/ClearPath/StartMove) keeps the server alive on motion faults.

## Nodes (14 total)

| Node | Transport | Description |
|------|-----------|-------------|
| `gofa-robot` | config | Shared config: IP, RWS port 443, socket port 1025, creds, points file |
| `gofa-status` | RWS | Reads ctrlstate, opmode, speedratio, RAPID execstate |
| `gofa-pose` | RWS | Current TCP pose (x,y,z + quaternion + config flags) |
| `gofa-joints` | RWS | All 6 joint angles in degrees |
| `gofa-system-info` | RWS | RobotWare version, controller name/ID/type/MAC |
| `gofa-elog` | RWS | Controller event log entries |
| `gofa-motor` | RWS | Motor on/off via `POST /rw/panel/ctrl-state` |
| `gofa-move` | Socket | HOME or SETHOME |
| `gofa-movej` | Socket | Absolute joint move |
| `gofa-jog` | Socket | Cartesian jog (X/Y/Z ± mm or RX/RY/RZ ± °) |
| `gofa-joint-jog` | Socket | Single joint jog |
| `gofa-grip` | Socket | GRIPON / GRIPOFF |
| `gofa-zone-set` | Socket | Set path blend zone |
| `gofa-speed-set` | Socket | Speed override % via `SpeedRefresh` (no mastership needed) |
| `gofa-stop-motion` | Socket | Halt motion immediately |
| `gofa-ping` | Socket | Connectivity test, measures round-trip time |
| `gofa-save-point` | RWS + disk | Read pose via RWS, save as named point in `points.json` |
| `gofa-go-point` | Socket + disk | Look up saved point, send GOTO token |
| `gofa-point-list` | disk | Output full saved-point array |
| `gofa-delete-point` | disk | Remove a saved point by name |
| `gofa-points-export` | disk | Dump points list to `msg.payload` |
| `gofa-points-import` | disk | Replace points list from `msg.payload` |
| `gofa-sequencer` | Socket + disk | Visit saved points in order; dwell, loop, ping-pong |
| `gofa-stop-seq` | in-memory | Sets `_seqStop` flag on the robot config node |
| `gofa-rapid-exec` | RWS | Start/stop/resetPP RAPID program *(requires PC Interface option)* |
| `gofa-rapid-var-read` | RWS | Read a RAPID PERS/VAR value |
| `gofa-rapid-var-write` | RWS | Write a RAPID PERS variable *(requires PC Interface option)* |
| `gofa-file-read` | RWS | Download a file from controller filesystem |
| `gofa-upload-mod` | RWS | Upload a `.mod` file to controller filesystem |
| `gofa-ai-read` | RWS | Read analog input |
| `gofa-ao-write` | RWS | Write analog output |
| `gofa-di-read` | RWS | Read digital input |
| `gofa-do-write` | RWS | Write digital output |

## Saved points format

Stored in `points.json` on the Node-RED host (not on the robot):
```json
[{ "id": "uuid", "name": "pick1", "target": { "x":323.2, "y":-81.8, "z":807.0, "q1":0.267, "q2":0.129, "q3":0.954, "q4":-0.053, "cf1":-1, "cf4":-1, "cf6":0, "cfx":0 } }]
```
GOTO token rounds to 1 dp (xyz) / 4 dp (quaternion) to stay under RAPID's 80-char string limit. RAPID re-normalizes the quaternion on receipt.

## RWS key endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `GET /rw/panel/ctrl-state` | GET | `ctrlstate`: motoron/motoroff/guardstop/emergencystop |
| `GET /rw/panel/opmode` | GET | `opmode`: auto/manualreduced/manualfull |
| `GET /rw/panel/speedratio` | GET | `speedratio`: 0–100 |
| `GET /rw/rapid/execution` | GET | `ctrlexecstate`: running/stopped |
| `GET /rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base` | GET | x,y,z mm + q1..q4 + cf1,cf4,cf6,cfx |
| `GET /rw/motionsystem/mechunits/ROB_1/jointtarget` | GET | rax_1..rax_6 degrees |
| `POST /rw/panel/ctrl-state` | POST | body: `ctrl-state=motoron` or `ctrl-state=motoroff` |
| `POST /rw/rapid/execution?action=start\|stop\|resetpp` | POST | *(requires PC Interface option)* |
| `PUT /fileservice/$HOME/Programs/<file>` | PUT | Upload file to controller |

## Default connection settings

| Setting | Value |
|---------|-------|
| Robot IP | `192.168.20.18` |
| RWS port | `443` (HTTPS, self-signed cert — `rejectUnauthorized: false`) |
| Socket port | `1025` |
| Username | `Admin` |
| Password | `robotics` |

## Repo layout

```
node-red-contrib-abb-gofa/   ← npm palette package
rapid/MainModule.mod          ← RAPID socket server (must run on controller)
flows/gofa_demo_flow.json     ← one inject per node, for testing
```
