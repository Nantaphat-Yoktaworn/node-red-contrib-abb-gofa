# ABB GoFa 12 (CRB 15000-12/1.27) — Node-RED Palette

Node-RED palette for controlling the **ABB GoFa 12** (CRB 15000-12/1.27) collaborative robot over
the network — motion, telemetry, I/O, RAPID program control, and teach-and-replay of saved
positions. No extra ABB licenses or hardware required beyond the standard OmniCore C30 controller.

```
[inject] → [gofa-jog: Z +10mm] → the arm moves
```

## ⚠️ Safety and security

**This software moves a real robot arm.**

- The software **STOP** command and Node-RED itself are *not* safety functions. The robot's own safety controller, reduced-speed collaborative limits, and the physical emergency stop are the only real safety layer — never rely on a flow to keep people safe.
- The RAPID socket server (port 1025) accepts motion commands from **anyone who can reach the robot's IP — there is no authentication on that port**. Run the robot on an isolated or firewalled network segment. RWS credentials are sent over HTTPS with certificate checking disabled (self-signed controller cert), so the same isolation assumption applies there.
- Jog/rotate step limits (50 mm / 30° per command) are enforced in the RAPID module, not in Node-RED — if you edit `MainModule.mod`, keep them.
- Every node's edit dialog has live-action buttons (jog, move, motors on/off, …) backed by Node-RED **admin HTTP endpoints**. The browser confirmation dialogs are convenience only, not a security control. **Configuring [`adminAuth`](https://nodered.org/docs/user-guide/runtime/securing-node-red) is required, not optional, on any instance controlling a real robot.** These motion endpoints are **refused (HTTP 403) when `adminAuth` is not configured**, so an unauthenticated editor port can no longer be used to move the robot. For a deployment that relies on network isolation instead of `adminAuth`, tick **Allow insecure live control** on the `gofa-robot` config node to re-enable them (at your own risk). This guard covers the editor buttons only — deployed flows use a separate runtime path and are never affected.

## Documentation

| | |
|---|---|
| **[Getting started](docs/getting-started.md)** | Controller setup, install, and your first robot move. **Start here.** |
| **[Node reference](docs/reference.md)** | Every node, the `msg.payload` conventions, EGM, and the background task |
| **[Troubleshooting](docs/troubleshooting.md)** | Symptoms and fixes, grouped by what you actually see |
| **[Changelog](CHANGELOG.md)** | Release history and migration notes for removed nodes |
| **[Manual control](MANUAL_CONTROL.md)** | Drive the robot with `curl` / raw TCP, no Node-RED needed |

Every node also has full usage docs in the Node-RED sidebar help — select a node and open the
**Help** tab.

## Install

```bash
cd ~/.node-red
npm install node-red-contrib-abb-gofa
```

Or **Menu → Manage palette → Install** and search for `node-red-contrib-abb-gofa`. Restart
Node-RED; the **ABB-GoFa-12** category appears in the palette sidebar.

The palette alone isn't enough to move the arm — the bundled RAPID module has to be running on the
controller, and you need an RWS user with the right grants. Both are covered in
**[Getting started](docs/getting-started.md)**.

## Requirements

- ABB GoFa (CRB 15000) with an OmniCore controller
- RobotWare 7.x — it must run **RWS 2.0** (path-based actions, not the IRC5-era `?action=` query form)
- Node-RED ≥ 3.0, Node.js ≥ 18
- RobotStudio (free) — once, to create an RWS user
- **Optional:** RobotWare Multitasking `[3114-1]`, only for the [background task](docs/reference.md#background-task-backgroundledmod--t_led)

No extra RobotWare options are needed for the base feature set — RWS is built into every OmniCore
controller.

## How it works

Two transports, one rule: **motion goes through a TCP socket, everything else goes through RWS.**

```
Node-RED ──TCP 1025──▶ RAPID socket server (MainModule.mod, running on the controller)
                            └─ motion, GETVAR/SETVAR, PING …

Node-RED ──HTTPS 443──▶ RWS, built into OmniCore
                            └─ state, pose, motors, RAPID start/stop, I/O, files
```

Routing motion through the socket avoids mastership conflicts with the FlexPendant and gives an
instant acknowledgment before the move executes. RWS-only nodes (status, pose, joints, I/O) work
without the RAPID module; motion nodes need it loaded and running.

## Upgrading

Node removals in this project are **replacements, not aliases** — a flow built with an older
version will show "unknown node" for a removed type and has to be edited. See
**[CHANGELOG.md](CHANGELOG.md)** for what to replace each one with. The merges you're most likely
to hit: `gofa-joint-jog` → `gofa-jog` (2.6.0), and the four point nodes → `gofa-points` (2.5.0,
which also moved point storage onto the robot).

## What's in this repo

```
node-red-contrib-abb-gofa/       ← Node-RED palette (npm installable: node-red-contrib-abb-gofa)
rapid/
  MainModule.mod                 ← RAPID socket server (must run on controller) — the default
  MainModuleEGM.mod              ← Optional sibling: adds EGM streaming support
  BackgroundLed.mod              ← Optional: separate-task background server (LED + digital-output
                                   writes), survives T_ROB1 being stopped
flows/
  gofa_demo_flow.json            ← One inject per node — good for testing each feature
  setup_flow.json                ← One-click first-run setup flow
  pickplace_sorting_flow.json    ← Pick-and-place sorting cell example
  teach_flow.json                ← Physical-button teach workflow
  watchdog_flow.json             ← Self-healing socket-wedge watchdog
  mqtt_bridge_flow.json          ← Publishes state/pose/io onto MQTT topics
  egm_conveyor_demo_flow.json    ← EGM conveyor-tracking demo (simulated target)
  brake_check_reminder_flow.json ← Detects the Cyclic Brake Check warning in the event log
docs/                            ← Documentation (see the table above), plus per-subsystem
                                   deep-dives for maintainers
MANUAL_CONTROL.md                ← Control the robot directly (curl / raw TCP)
CHANGELOG.md                     ← Release history and upgrade notes
```

The same example flows ship inside the npm package — **Menu → Import → Examples →
node-red-contrib-abb-gofa**.

## Tests

From a git checkout (the suite is not included in the npm package):

```bash
cd node-red-contrib-abb-gofa && npm test
```

## License

[MIT](LICENSE)
