# node-red-contrib-abb-gofa

Node-RED nodes for controlling an **ABB GoFa (CRB 15000)** collaborative robot with an **OmniCore** controller over the local network. Motion, telemetry, I/O, RAPID program control, saved-point teach & replay — no extra ABB licenses required.

Developed and live-tested against a GoFa 12 (CRB 15000-12/1.27) on an OmniCore C30, RobotWare 7.21.

## ⚠️ Safety and security

**This package moves a real robot arm.**

- The software **STOP** command and Node-RED itself are *not* safety functions. The robot's own safety controller, reduced-speed collaborative limits, and the physical emergency stop are the only real safety layer. Never rely on a flow to keep people safe.
- The RAPID socket server (port 1025) accepts motion commands from **anyone who can reach the robot's IP — there is no authentication on that port**. Run the robot on an isolated or firewalled network segment. The same goes for RWS credentials sent over HTTPS with certificate checking disabled (the controller uses a self-signed certificate).
- Jog/rotate step limits (50 mm / 30°) are enforced in the RAPID module, not in Node-RED — if you edit `MainModule.mod`, keep them.

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

Restart Node-RED — a `gofa-robot` config node and 39 `gofa-*` nodes appear under the **GoFa** category.

## Controller setup (once)

**1. Create an RWS user.** The built-in `Admin` account cannot start/stop RAPID remotely. In RobotStudio: connect to the controller → **Authenticate** → **Edit User Accounts** → add a role with the **Remote Start** and **Remote Stop** grants → create a user with that role. Read-only nodes work with any account.

**2. Upload the RAPID module.** The module ships in this package. Easiest path: add a `gofa-upload-mod` node and set its **Local Path** to the *absolute* path of the bundled file (e.g. `/home/pi/.node-red/node_modules/node-red-contrib-abb-gofa/rapid/MainModule.mod` — a relative path resolves against the Node-RED process directory, not your user dir). It uploads over RWS and automatically patches the module's `SERVER_IP` constant to your robot's IP (the RAPID socket server cannot bind a wildcard address, so this must match). Or upload manually:

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

| Node | Transport | Description |
|------|-----------|-------------|
| `gofa-robot` | config | Shared connection settings (IP, ports, credentials, points storage) |
| `gofa-status` | RWS | Controller state, operating mode, speed ratio, RAPID execution state |
| `gofa-pose` | RWS | Current TCP pose (position + quaternion + config flags) |
| `gofa-joints` | RWS | All 6 joint angles |
| `gofa-system-info` | RWS | RobotWare version, controller identity |
| `gofa-elog` | RWS | Controller event log |
| `gofa-motor` | RWS | Motors on/off |
| `gofa-move` | Socket | Go home / set home |
| `gofa-movej` | Socket | Absolute joint move |
| `gofa-jog` | Socket | Cartesian jog (±mm / ±°) |
| `gofa-joint-jog` | Socket | Single-joint jog |
| `gofa-zone-set` | Socket | Path blend zone (FINE…Z100) |
| `gofa-speed-set` | Socket | Speed override % |
| `gofa-stop-motion` | Socket | Immediate motion halt |
| `gofa-ping` | Socket | Connectivity test with round-trip time |
| `gofa-grip` | RWS | Digital output on/off (gripper-style) |
| `gofa-save-point` / `gofa-go-point` / `gofa-point-list` / `gofa-delete-point` | mixed | Teach & replay named points, stored locally or on the robot's own disk |
| `gofa-points-export` / `gofa-points-import` | disk | Bulk export/import of the point list |
| `gofa-sequencer` / `gofa-stop-seq` | Socket | Visit saved points in order (dwell, loops, ping-pong) / stop the sequence |
| `gofa-rapid-exec` | RWS | Start / stop / reset-PP / load / activate RAPID program |
| `gofa-rapid-var-read` / `gofa-rapid-var-write` | Socket | Read/write RAPID PERS variables |
| `gofa-rapid-tasks` | RWS | List RAPID tasks and modules |
| `gofa-upload-mod` / `gofa-file-read` | RWS | Upload / download controller files |
| `gofa-io-list` / `gofa-di-read` / `gofa-do-write` | RWS | List signals, read inputs, write outputs |
| `gofa-leadthrough-enable` / `gofa-leadthrough-disable` | Socket + RWS | Hand-guiding (lead-through) on/off |
| `gofa-asi-led` | Socket | Arm status-light color and blink |
| `gofa-subscribe-state` / `gofa-subscribe-io` | RWS WebSocket | Push on controller-state / I/O-signal changes |
| `gofa-subscribe-var` / `gofa-subscribe-pose` | RWS poll | Poll a RAPID variable / TCP pose on an interval |

The full RAPID socket protocol reference, RWS endpoint notes, and troubleshooting guide are in the [GitHub README](https://github.com/Nantaphat-Yoktaworn/node-red-contrib-abb-gofa#readme).

## Test

From a git checkout (the test suite is not included in the npm package):

```bash
npm test
```

Runs `test.js` — unit tests for the pure helpers (`gotoToken`, `parseXhtml`, points persistence, LED payload resolution) plus integration-style tests that drive node `input` handlers against a minimal Node-RED harness.

## License

[MIT](LICENSE)
