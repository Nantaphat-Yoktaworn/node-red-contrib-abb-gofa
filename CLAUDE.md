# ABB GoFa 12 (CRB 15000-12/1.27) — Claude Code Context

Custom Node-RED palette (`node-red-contrib-abb-gofa`) for controlling an ABB GoFa 12 (CRB 15000-12/1.27) collaborative robot over a local network. No extra ABB licenses required.

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
| `GOTOJx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveJ (joint-interpolated, 11 `;`-separated numbers) |
| `GOTOLx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveL (straight-line TCP path) |
| `X+20` / `Y-10` / `Z+5` | Translate TCP ±mm in base frame (max 50 mm) |
| `RX+5` / `RY-10` / `RZ+15` | Rotate TCP ±° in tool frame (max 30°) |
| `J1+10` / `J3-5` | Jog single joint ±° (max 30°, joints 1–6) |
| `SPEED50` | Set speed override 1–100% |
| `MOVEJ<j1;j2;j3;j4;j5;j6>` | Absolute joint move in degrees |
| `ZONE<name>` | Set path blend zone (FINE / Z1 / Z5 / Z10 / Z20 / Z50 / Z100) |
| `STOP` | Halt motion immediately |
| `PING` | Connectivity test |
| `GRIPON` / `GRIPOFF` | Gripper control via digital output |
| `GETVAR:<name>` | Read a PERS variable; replies `VAL:<value>` or `ERR:UNKNOWN_VAR` |
| `SETVAR:<name>:<value>` | Write a PERS variable; replies `OK:SETVAR`, `ERR:UNKNOWN_VAR`, or `ERR:PARSE` |
| `SETLED:<r>;<g>;<b>;<period>` | Set ASI status light color (0–255 each) and hardware blink period; replies `OK:SETLED` |
| `RESETLED` | Restore ASI LED to default RAPID-running state (solid green); replies `OK:RESETLED` |

Ack is sent **before** the motion starts. RAPID error handler (StopMove/ClearPath/StartMove) keeps the server alive on motion faults.

**GETVAR/SETVAR note**: variable names are uppercased by CleanCmd in RAPID (`nTestVar` → matched as `NTESTVAR`). String values are extracted from `rawclean` (preserves original case/spaces). To expose a new PERS variable, add an `ELSEIF` block in both `TryGetVar` and `TrySetVar` in `MainModule.mod`. Built-in: `nTestVar` (num), `sTestMsg` (string).

**SETLED/RESETLED note**: ASI signals have `Rapid|LocalManual` write access — HTTP RWS cannot write them. All LED control must go through the RAPID socket server. `TrySetLed` in `MainModule.mod` handles the `SETLED` command via `SetGO` on `Asi1LedRed`, `Asi1LedGreen`, `Asi1LedBlue`, `Asi1LedPeriod`. Software-controlled counted blink (Node-RED side) is handled by `gofa-asi-led` when `blinkCount > 0`; in that case `period` is ignored and set to 0.

**SERVER_IP note**: `MainModule.mod` binds its socket server with `CONST string SERVER_IP := "..."`, which RAPID's `SocketBind` requires to be a real configured interface address (no wildcard bind). If this drifts from the controller's actual IP, `SocketBind` silently fails and every socket command times out with no error on the controller side. `gofa-upload-mod` mitigates this by always rewriting `SERVER_IP` to the `gofa-robot` config node's IP on every upload (`patchServerIp` no-ops on any file that doesn't contain the constant, so this is safe for uploading other files too); the constant in the repo copy is just the fallback for a first upload or manual FlexPendant/SD-card load.

**GOTOJ/GOTOL note**: bare `GOTO<11 nums>` (no `J`/`L` letter) is still accepted by `TryGoTo` as an alias for `GOTOJ`, for backward compatibility. `gofa-go-point` and `gofa-sequencer` always send the explicit `J`/`L` form based on their "Move type" dropdown. `MoveJ` (joint-interpolated) is the more predictable/reliable choice — RAPID has freedom in how each axis gets there, so it won't fault or slow drastically near a singularity — and is therefore the default at every fallback point: `gotoToken(t, moveType)` in `gofa-robot.js` maps anything other than exactly `'L'` to `'J'`, and both nodes' config defaults are `'J'`. `MoveL` follows a straight line to the target and can hit singularities or joint limits along that line that `MoveJ` would route around, so it's opt-in, not a safer default.

**RAPID start note**: `POST /rw/rapid/execution/start` returns HTTP 200 even when the controller immediately rejects the start (e.g. RAPID error 20055, "program must start in Motor On state") — the rejection isn't surfaced as an HTTP error, so a naive implementation reports `{ ok: true }` for a start that never ran. `gofa-rapid-exec` guards against this for the `start` action only: it reads `/rw/panel/ctrl-state` first and fails fast if motors aren't on, then polls `/rw/rapid/execution` (`ctrlexecstate`) for up to 1.5s after the POST to confirm it actually reached `running`. `stop`/`resetpp` don't have this silent-rejection failure mode and aren't checked.

**RAPID symbol data note**: RWS's generic `/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}` (the RWS 1.0 / IRC5-era documented endpoint for reading/writing any RAPID variable without touching RAPID code) returns `404 SYS_CTRL_E_UNRESOLVED_URL` on this controller. **Not a licensing issue** — verified against ABB's OmniCore C-line product manual (3HAC065034-001) that RWS is a standard, base-included feature, and that the OmniCore option in this area, RobotStudio Connect [3119-1], is unrelated (it's about the RobotStudio desktop app connecting over WAN). The real cause: `GET /rw/rapid` on this controller advertises `symbols` (plural), a search-based resource (`?action=search-symbols` + `view`/`blockurl`/`regexp`/`posl`/`posc` filters), not the flat singular `symbol` path from the general RWS docs — the same RWS 1.0-vs-2.0 shape split already seen for `execution` and `iosystem`. Exact working invocation not yet found (query-action POST → 405, path-based POST → 404, module-scoped `symbol` browser → always empty). Full investigation, what was tried, and what's confirmed vs open: see the `abb-rws` and `omnicore-c30` skills. This is why variable read/write goes through the custom TCP `GETVAR:`/`SETVAR:` protocol (allow-listed per variable in `TryGetVar`/`TrySetVar`) — proven and simple, not a workaround for a missing option. `gofa-subscribe-var`'s `readVar()` used to try the dead RWS symbol path before falling back to module-text on every poll; that guaranteed-fail round trip was removed once the endpoint was confirmed permanently broken on this hardware (not just occasionally), so it now goes straight to module-text and always reports `source: 'module-text'`.

**Module-text fallback is confirmed STALE, not just unverified** (`gofa-rapid-var-read`'s fallback and `gofa-subscribe-var`'s only path — reading `/rw/rapid/tasks/{task}/modules/{module}/text` + fileservice, regex-matching `name := value`): tested live by writing a new value to `nTestVar` via socket `SETVAR`, confirming the write with socket `GETVAR` (got the new value), then reading the same variable through this RWS path — it returned the *original* compiled/declared value, not the one just written. This path reflects the module's compiled state, not the variable's live runtime value. Both nodes now mark it `stale: true` with a `warning` field in the payload instead of presenting it with the same confidence as a live socket-`GETVAR` read (`source: 'socket'`, no `stale` field). There is no known live-value alternative for variables outside the `TryGetVar`/`TrySetVar` allow-list until the `/rw/rapid/symbols` search API (see above) is cracked.

## Nodes (42 total)

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
| `gofa-go-point` | Socket + disk | Look up saved point, send GOTO token; move type (MoveJ/MoveL) selectable per-node or per-message |
| `gofa-point-list` | disk | Output full saved-point array |
| `gofa-delete-point` | disk | Remove a saved point by name |
| `gofa-points-export` | disk | Dump points list to `msg.payload` |
| `gofa-points-import` | disk | Replace points list from `msg.payload` |
| `gofa-sequencer` | Socket + disk | Visit saved points in order; per-step dwell + move type override, loop count, ping-pong, startStep |
| `gofa-stop-seq` | Socket + in-memory | Sets `_seqStop` flag and sends immediate `STOP` socket command |
| `gofa-rapid-exec` | RWS | Start/stop/resetPP RAPID program *(requires Remote Start/Stop UAS grants)* |
| `gofa-rapid-var-read` | Socket | Read a RAPID PERS variable via `GETVAR:<name>` socket command |
| `gofa-rapid-var-write` | Socket | Write a RAPID PERS variable via `SETVAR:<name>:<value>` socket command |
| `gofa-rapid-tasks` | RWS | List RAPID tasks and the modules loaded in one of them |
| `gofa-file-read` | RWS | Download a file from controller filesystem |
| `gofa-upload-mod` | RWS | Upload a `.mod` file to controller filesystem; auto-syncs `SERVER_IP` to the config node's IP unless disabled |
| `gofa-io-list` | RWS | List all I/O signals |
| `gofa-ai-read` | RWS | Read analog input |
| `gofa-ao-write` | RWS | Write analog output |
| `gofa-di-read` | RWS | Read digital input |
| `gofa-do-write` | RWS | Write digital output |
| `gofa-leadthrough-enable` | Socket + RWS | Send STOP (clears queued moves), then activate hand-guiding via RWS |
| `gofa-leadthrough-disable` | RWS | Deactivate hand-guiding |
| `gofa-asi-led` | Socket | Set ASI status light RGB color + counted software blink via `SETLED` / `RESETLED` |
| `gofa-subscribe-state` | RWS WS | Push on every controller state change; one-shot mode polls once per inject |
| `gofa-subscribe-io` | RWS WS | Push on every I/O signal change; falls back to 500 ms polling if signal lacks WS support; one-shot mode available |
| `gofa-subscribe-var` | RWS poll | Poll a RAPID variable on an interval; toggles on/off per inject |
| `gofa-subscribe-pose` | RWS poll | Poll TCP position on an interval; stops if inject has no payload |

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
| `POST /rw/rapid/execution/start` · `/stop` · `/resetpp` | POST | *(requires Remote Start/Stop UAS grants; resetpp also needs edit mastership — acquired automatically)* |
| `PUT /fileservice/$HOME/Programs/<file>` | PUT | Upload file to controller |
| `GET /rw/rapid/tasks` | GET | List of RAPID tasks: name, type, taskstate, excstate, active, motiontask |
| `GET /rw/rapid/tasks/{task}/modules` | GET | Modules loaded in a task: name, type (ProgMod/SysMod) |

## Default connection settings

| Setting | Value |
|---------|-------|
| Robot IP | `192.168.20.33` |
| RWS port | `443` (HTTPS, self-signed cert — `rejectUnauthorized: false`) |
| Socket port | `1025` |
| Username | `NNNN` |
| Password | `robotics` |

## Repo layout

```
node-red-contrib-abb-gofa/        ← npm palette package
rapid/MainModule.mod               ← RAPID socket server (must run on controller)
flows/gofa_demo_flow.json          ← one inject per node, for testing
flows/dashboard_flow.json          ← full robot control palette flow
```
