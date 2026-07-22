# node-red-contrib-abb-gofa

Node-RED nodes for controlling an **ABB GoFa (CRB 15000)** collaborative robot with an **OmniCore** controller over the local network. Motion, telemetry, I/O, RAPID program control, saved-point teach & replay — no extra ABB licenses required.

Developed and live-tested against a GoFa 12 (CRB 15000-12/1.27) on an OmniCore C30, RobotWare 7.21.

## ⚠️ Safety and security

**This package moves a real robot arm.**

- The software **STOP** command and Node-RED itself are *not* safety functions. The robot's own safety controller, reduced-speed collaborative limits, and the physical emergency stop are the only real safety layer. Never rely on a flow to keep people safe.
- The RAPID socket server (port 1025) accepts motion commands from **anyone who can reach the robot's IP — there is no authentication on that port**. Run the robot on an isolated or firewalled network segment. The same goes for RWS credentials sent over HTTPS with certificate checking disabled (the controller uses a self-signed certificate).
- Jog/rotate step limits (50 mm / 30°) are enforced in the RAPID module, not in Node-RED — if you edit `MainModule.mod`, keep them.
- The node property panels have live-action buttons (jog, move, motors on/off, …) backed by Node-RED admin HTTP endpoints. The browser confirmation dialogs are convenience only, not a security control. **Configure [`adminAuth`](https://nodered.org/docs/user-guide/runtime/securing-node-red) on any Node-RED instance controlling a real robot** — it is required, not optional. As of 2.4.10 these motion endpoints are **refused (HTTP 403) when `adminAuth` is not configured**, so an unauthenticated editor port can no longer trigger motion. If your instance has no `adminAuth` but is genuinely protected another way (isolated cell network / firewall / reverse proxy), tick **Allow insecure live control** on the `gofa-robot` config node to re-enable them at your own risk. Deployed flows are unaffected either way — this guard only covers the editor buttons.

## How it works

Two transports, one rule — **motion goes through a TCP socket, everything else goes through RWS**:

- **TCP socket (port 1025)** — a small RAPID program (`rapid/MainModule.mod`, bundled with this package) runs a socket server on the controller. Each motion node opens a connection, sends one newline-terminated command (`HOME`, `GOTOJ…`, `J1+10`, …), reads one `OK:`/`ERR:` reply, and closes.
- **Robot Web Services (HTTPS, port 443)** — OmniCore's built-in REST API, used for telemetry (pose, joints, state), motor on/off, RAPID start/stop, I/O read/write, file transfer, and WebSocket subscriptions.

RWS-only nodes (status, pose, joints, I/O, …) work without the RAPID module; motion nodes need it loaded and running.

## Requirements

- ABB GoFa CRB 15000 with an OmniCore controller, RobotWare 7.x
- Node-RED ≥ 3.0, Node.js ≥ 18
- Network access to the controller (HTTPS 443 + TCP 1025)
- RobotStudio (free) — once, to create an RWS user with the right grants

## Install

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-abb-gofa
```

(or **Menu → Manage palette → Install** inside the Node-RED editor.)

Restart Node-RED — a `gofa-robot` config node and 43 `gofa-*` nodes appear under the **GoFa** category.

## Controller setup (once)

**1. Create an RWS user.** The built-in `Admin` account cannot start/stop RAPID remotely. In RobotStudio: connect to the controller → **Authenticate** → **Edit User Accounts** → add a role with the **Remote Start** and **Remote Stop** grants → create a user with that role. Read-only nodes work with any account.

**2. Upload the RAPID module.** The module ships in this package. Easiest path: add a `gofa-file` node (action **upload**) and set its **Local Path** to the *absolute* path of the bundled file (e.g. `/home/pi/.node-red/node_modules/node-red-contrib-abb-gofa/rapid/MainModule.mod` — a relative path resolves against the Node-RED process directory, not your user dir). It uploads over RWS and automatically patches the module's `SERVER_IP` constant to your robot's IP (the RAPID socket server cannot bind a wildcard address, so this must match). Or upload manually:

```bash
curl -sk -u <user>:<password> -X PUT -H "Content-Type: text/plain;v=2.0" \
  --data-binary @rapid/MainModule.mod \
  "https://<ROBOT_IP>/fileservice/\$HOME/Programs/MainModule.mod"
```

(If you upload manually, edit `SERVER_IP` in the file to your robot's IP first.)

**3. Load and start it on the FlexPendant.** **Code** → **⋮** → **Load Module** → `HOME/Programs/MainModule.mod`, then **Debug** → **PP to Main**, switch to **Auto** mode, **Motors on**, **Play** (▶). The controller now answers on port 1025 (test: send `PING\n`, expect `OK:PING`).

## Usage

1. Open any `gofa-*` node → add a **gofa-robot** config node: robot IP, ports (443 / 1025), the username/password from step 1.
2. Wire an `inject` into e.g. `gofa-status` or `gofa-ping` to verify connectivity, then go from there.
3. Every node has full usage docs in the Node-RED sidebar help.

Ready-made example flows (a per-node demo, a full control dashboard, and a physical-button teach workflow) are in the [GitHub repo's `flows/` directory](https://github.com/Nantaphat-Yoktaworn/node-red-contrib-abb-gofa/tree/main/flows).

## Nodes

Every node below (except the `gofa-robot` config node) has an **Output payload (debug)**
checkbox, unchecked by default. Unchecked, a node still fires on completion to trigger the
next node in the flow, but with an empty payload instead of full debug data — no `change` node
needed just to silence output. Check it to get the full `msg.payload` described per node below.

| Node | Transport | Description |
|------|-----------|-------------|
| `gofa-robot` | config | Shared connection settings (IP, ports, credentials, points storage) |
| `gofa-status` | RWS | Controller state, operating mode, speed ratio, RAPID execution state |
| `gofa-connection-status` | RWS + Socket + Background | Checks RWS, the TCP socket server, and the [Background task](#background-task-optional) independently — reachable? reply time? — without assuming any one already works; also reports each layer's module version and whether an EGM session is active |
| `gofa-pose` | RWS | Current TCP pose (position + quaternion + config flags) |
| `gofa-joints` | RWS | All 6 joint angles |
| `gofa-system-info` | RWS | RobotWare version, controller identity |
| `gofa-elog` | RWS | Controller event log — Domain (category) + Min Severity (info/warning+/error-only) filters |
| `gofa-motor` | RWS | Motors on/off |
| `gofa-move` | Socket | Go home / set home |
| `gofa-movej` | Socket | Absolute joint move ("Move Joints") — Move type: Joint (default) / Linear. Validates each target angle against the robot's Joint Limits (CRB 15000-12 defaults) before sending — an out-of-range target returns a clean error instead of faulting RAPID |
| `gofa-jog` | Socket | Cartesian jog (±mm / ±°) |
| `gofa-joint-jog` | Socket | Single-joint jog |
| `gofa-zone-set` | Socket | Path blend zone (FINE…Z100) |
| `gofa-speed-set` | Socket | Speed override via `VelSet` — set or read current (`C_MOTSET.vel.oride`); see CLAUDE.md for why `SpeedRefresh` doesn't work here |
| `gofa-stop-motion` | RWS + Socket | Motion halt. **Mode**: `immediate` (default) halts an in-progress HOME/GOTOJ/GOTOL/MOVEJ/MOVEL now via an RWS execution-stop + auto resetPP/start (arm stays put, socket recovers; needs Auto + motors on); `queued` is the legacy socket STOP that only cancels a not-yet-started move |
| `gofa-ping` | Socket | Connectivity test with round-trip time |
| `gofa-grip` | RWS | Digital output on/off (gripper-style) |
| `gofa-save-point` / `gofa-go-point` / `gofa-point-list` / `gofa-delete-point` | mixed | Teach & replay named points, stored locally or on the robot's own disk |
| `gofa-points` | disk | Bulk export/import of the point list (action: export / import — import **replaces** the whole list) |
| `gofa-sequencer` / `gofa-stop-seq` | Socket | Visit saved points in order (dwell, loops, ping-pong) / stop the sequence |
| `gofa-setup` | RWS + Socket | One-click first-run init for `T_ROB1` only: upload the bundled RAPID module (SERVER_IP auto-synced), load, reset PP, motors on, start, verify socket — with a per-step report. Does not set up the [Background task](#background-task-optional) |
| `gofa-rapid-exec` | RWS | Start / stop / reset-PP / load / unload / activate RAPID program |
| `gofa-rapid-var-read` / `gofa-rapid-var-write` | Socket | Read/write RAPID PERS variables |
| `gofa-rapid-tasks` | RWS | List RAPID tasks and modules |
| `gofa-file` | RWS | Upload / download / delete controller files (action dropdown; upload auto-syncs `SERVER_IP`) |
| `gofa-mod-edit` | RWS | Edit a `.mod` (or any text) file on the controller's disk right in the node's edit dialog — pick a file in `$HOME/Programs` (or name a new one), Load/Save to robot, `SERVER_IP` auto-synced |
| `gofa-io-list` / `gofa-di-read` | RWS | List signals, read inputs |
| `gofa-do-write` | RWS, Socket, or Background | Write outputs — Transport dropdown: RWS `/set-value` (default, needs `Access: All`), Socket `SETDO` (needs RAPID running), or [Background task](#background-task-optional) (works while `T_ROB1` is stopped) |
| `gofa-leadthrough` | Socket + RWS | Hand-guiding (lead-through) on/off (action: enable / disable) |
| `gofa-asi-led` | Socket, RWS, or Background | Arm status-light color and blink — Transport dropdown, same three options as `gofa-do-write` above |
| `gofa-subscribe-state` / `gofa-subscribe-io` | RWS WebSocket | Push on controller-state / I/O-signal changes |
| `gofa-subscribe-var` / `gofa-subscribe-pose` | RWS poll | Poll a RAPID variable / TCP pose on an interval |
| `gofa-subscribe-elog` | RWS WebSocket | Push new event log entries in real time; same Domain/Min Severity filters as `gofa-elog` |
| `gofa-egm` / `gofa-egm-move` | UDP (EGM) | Sub-10ms joint-position streaming — see [EGM (optional)](#egm-optional) below, requires `MainModuleEGM.mod` |

The full RAPID socket protocol reference, RWS endpoint notes, and troubleshooting guide are in the [GitHub README](https://github.com/Nantaphat-Yoktaworn/node-red-contrib-abb-gofa#readme).

## EGM (optional)

`gofa-egm` + `gofa-egm-move` stream joint positions over **EGM (Externally Guided Motion)** — a
UDP/protobuf channel capable of sub-10ms closed-loop motion, unlike the TCP socket protocol or
RWS (which tops out around 500ms). It needs its own RAPID module and a one-time controller
config, so it's opt-in rather than part of the default setup above.

**Two nodes, split by job.** `gofa-egm` only starts/stops the EGM session and emits telemetry —
it has an Action dropdown (`Start EGM` / `Stop EGM`), same pattern as `gofa-motor`/
`gofa-rapid-exec`. `gofa-egm-move` is a separate node that sets the movement target: send it a
`[j1..j6]` array and it checks whether a `gofa-egm` session is active on the same Robot — if so,
it updates the live target (output 1); if not, it routes the message unchanged to a fallback
output (output 2) instead of erroring, e.g. to wire straight into `gofa-movej` for a normal
non-EGM move.

**Two RAPID modules, one choice at a time:**

| Module | Use when |
|---|---|
| `rapid/MainModule.mod` | Default. Everything in this README works. No EGM support. |
| `rapid/MainModuleEGM.mod` | A full clone of `MainModule.mod` plus one added command, `EGMJOINT`, that switches the controller into a blocking EGM session. Load this instead when a flow needs `gofa-egm`. |

Only one can run at a time — whichever is loaded on the controller. **Switching requires
unloading the currently-loaded module first** — `loadmod`'s `replace` option only replaces a
module with the *same name*, and `MainModule`/`MainModuleEGM` are different names, so loading
one while the other is still loaded leaves both loaded and RAPID rejects start with "Global
routine name main ambiguous" (both declare `PROC main()`). Full switch sequence either
direction: `gofa-rapid-exec` (`stop`) → `gofa-rapid-exec` (`unloadmod`, naming the module
*currently* loaded — this only detaches it from the task, the file stays on the controller's
disk) → `gofa-file` upload (the other file) → `gofa-rapid-exec` (`loadmod` → `resetpp` →
`start`). `gofa-egm` detects the wrong module itself (`start` fails with a clear "load
MainModuleEGM.mod first" error instead of hanging) — but there is no way to run without one or
the other, so mixing them up just costs a reload, not a broken robot.

**Why two modules instead of one:** an EGM session (`EGMRunJoint`) blocks the RAPID task for
its whole duration, so the same task can't also be running the plain TCP socket server that
every other node in this package depends on — while `gofa-egm` is streaming, `gofa-jog`,
`gofa-go-point`, and the rest simply can't connect. Keeping EGM support in a separate module
means the default `MainModule.mod` — and everything that depends on it — is completely
unaffected by this feature; it's not merged into the file every other node already relies on.

**One-time controller setup**, not done by any node: a UDP Unicast Device named
`EGM_PC` (RobotStudio → Controller → Configuration → Communication → UDP Unicast Device →
right-click → New UDP Unicast Device...; Remote Address = the Node-RED host's IP on the robot's
subnet, Remote Port Number = the `gofa-egm` node's configured UDP port, default `6510`, Local
Port Number = `0`; requires a controller restart), and — on the Node-RED host — a firewall rule
allowing inbound UDP on that port.

**Caution — tool load data:** per ABB's EGM Application Manual, the robot should have correct
tool load data (`LoadIdentify`) before starting EGM — incorrect load data can cause servo
torque overruns or safety halts when EGM issues fast corrections. With no tool physically
mounted, `MainModuleEGM.mod`/`MainModule.mod` both target `tool0` (RAPID's built-in empty-flange
tool) rather than a placeholder tooldata, so there's no false load data to worry about right now.
Once a real gripper is mounted, run `LoadIdentify` (or otherwise measure its real mass/CoG/
inertia/TCP offset) and update both `.mod` files to use it before relying on EGM (or any motion)
with that tooling attached.

## Background task (optional)

Not required for anything above — every node in this package works without it. It exists to keep
LED feedback and digital-output writes working during a hand-guiding session (or any other time
`T_ROB1` is stopped), by running a small second RAPID module (`rapid/BackgroundLed.mod`) in its
own task. It backs the **Background** transport option on `gofa-do-write`/`gofa-asi-led`, and the
`background` field on `gofa-connection-status`. Setting it up needs one manual, one-time
RobotStudio step (creating a new RAPID task isn't possible over RWS at all) — see the
[GitHub README's "Background task" section](https://github.com/Nantaphat-Yoktaworn/node-red-contrib-abb-gofa#background-task-backgroundledmod--t_led)
for the exact steps.

Full node help (input/output shapes, config) is in the Node-RED sidebar for `gofa-egm` and
`gofa-egm-move`.

## Test

From a git checkout (the test suite is not included in the npm package):

```bash
npm test
```

Runs `test.js` — unit tests for the pure helpers (`gotoToken`, `parseXhtml`, points persistence, LED payload resolution, the hand-rolled EGM protobuf codec) plus integration-style tests that drive node `input` handlers against a minimal Node-RED harness.

## License

[MIT](LICENSE)
