# Documentation

Two kinds of document live in this folder. If you're here to *use* the palette, you only need the
first group.

## Using the palette

| Doc | Read it when |
|-----|--------------|
| **[Getting started](getting-started.md)** | Setting up for the first time — controller, RWS user, RAPID module, install, first move |
| **[Node reference](reference.md)** | Building a flow: what each node does, what `msg.payload` it accepts, EGM, the background task |
| **[Troubleshooting](troubleshooting.md)** | Something isn't working — grouped by the symptom you actually see |

Also useful: [CHANGELOG.md](../CHANGELOG.md) for migrating flows across versions, and
[MANUAL_CONTROL.md](../MANUAL_CONTROL.md) for driving the robot with `curl` or a raw TCP client
without Node-RED.

Every node additionally has its own help page in the Node-RED sidebar — select the node and open
the **Help** tab. That's the most detailed per-node documentation there is.

## Internals (for maintainers)

These record *why* things are built the way they are, including approaches that were tried and
failed. They assume you're changing the code, not using it.

| Doc | Covers |
|-----|--------|
| [rapid-protocol-notes.md](rapid-protocol-notes.md) | Full RAPID socket command table and every protocol-level gotcha and bugfix |
| [egm.md](egm.md) | Externally Guided Motion internals, mode switch/exit design, superseded designs |
| [background-led-task.md](background-led-task.md) | `BackgroundLed.mod` / `T_LED` mechanics and one-time RobotStudio setup |
| [version-handshake-watchdog.md](version-handshake-watchdog.md) | Module-vs-palette version handshake and the self-healing watchdog flow |
| [points-system.md](points-system.md) | On-robot point storage format and the five-into-one node merge |
| [jog-merge.md](jog-merge.md) | The 2.6.0 `gofa-joint-jog` → `gofa-jog` merge and its live-test evidence |
| [interactive-panels.md](interactive-panels.md) | Editor-panel live-action buttons and admin-route auth |
| [brake-check-reminder.md](brake-check-reminder.md) | Cyclic Brake Check elog-warning detection flow |
| [virtual-controller.md](virtual-controller.md) | RobotStudio Virtual Controller workflow — doc-only, **not live-verified** |
