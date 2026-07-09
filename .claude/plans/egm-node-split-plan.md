# Split `gofa-egm` into a session-control node + a `gofa-egm-move` movement node

## Context

Today's `gofa-egm` node (`nodes/gofa-egm.js`) does three unrelated jobs in one node type:
1. Session lifecycle — `"start"`/`"stop"` strings in `msg.payload` switch the controller into/out
   of EGM mode and manage the UDP socket.
2. Movement — a 6-number joint array (or `{joints:[...]}`) in `msg.payload` sets the live target
   the node streams to the robot.
3. Telemetry — throttled feedback output on every UDP frame.

Two problems this causes:
- To start/stop EGM you have to know the magic string payloads (`"start"`/`"stop"`). Every other
  action-style node in this palette (`gofa-motor`, `gofa-rapid-exec`) instead exposes an **Action
  dropdown in the node's edit panel**, with `msg.payload`/`msg.payload.action` as an override —
  so a bare inject (empty/date payload) just fires whichever action the node instance is
  configured for. The demo flow puts one node instance per action (e.g. "Motors ON" / "Motors
  OFF" are two `gofa-motor` instances), not one instance driven by different payload strings.
  `gofa-egm` doesn't follow this convention today.
- Movement (setting a target) is bundled into the same node as session control, and there's no
  way to tell a flow "if EGM isn't running, do something else instead" — sending a target while
  `!node._streaming` today just errors and drops the message, dead-ending the flow.

The user wants: (a) `gofa-egm` restructured to work like the other action-style nodes — an Action
dropdown (start/stop) driven by plain injects — and (b) movement split into its own node,
**`gofa-egm-move`**, that takes a target via input, forwards it into the running EGM session if
one is active, and otherwise routes the message to a **second, fallback output** so the flow can
wire in an alternative (e.g. a normal TCP `gofa-movej` absolute joint move) instead of silently
dropping the command.

This is a clean breaking change to `gofa-egm`'s `msg.payload` contract (joint-array input moves
out entirely) — consistent with this project's existing practice of clean removals over
back-compat shims (e.g. the analog-node removal). No deprecation shim.

## Design

### Shared session state moves onto the `gofa-robot` config node

The palette already has a proven pattern for exactly this kind of cross-node-type coordination:
`gofa-stop-seq.js` sets `node.robot._seqStop = true` directly on the shared `gofa-robot` config
node instance, and `gofa-sequencer.js` (a different node type, same config node) reads/clears
`r._seqStop`/`r._seqRunning` (`nodes/gofa-robot.js:271-274`, `nodes/gofa-stop-seq.js:9`,
`nodes/gofa-sequencer.js:19,63-64,69,72`). No abstraction layer, no getters/setters — just flat
`_xyz` fields on the config node object that `RED.nodes.getNode(config.robot)` returns as the
same singleton to every wired sibling node.

Apply the identical pattern for EGM: add three flat fields to `GoFaRobotNode`'s constructor in
`nodes/gofa-robot.js` (next to the existing `_seqStop`/`_seqRunning` block, `gofa-robot.js:271-274`):
```js
this._egmActive   = false;   // true once a session is actually streaming (first UDP frame in)
this._egmTarget   = null;    // current [j1..j6] target being echoed back every frame
this._egmBaseline = null;    // pose captured from the first frame of the session (hold anchor)
```
This also incidentally fixes a latent bug: today, two `gofa-egm` node instances pointed at the
same robot would each track independent `_streaming`/`_target` state despite the controller only
ever supporting one real EGM session — moving the flag onto the shared config node makes the
state model match reality.

### `gofa-egm` (session control only) — `nodes/gofa-egm.js` / `.html`

Keep this node type and file name (it already owns all the actual session mechanics: `start()`,
`stop()`, `bindSocket()`, `onFrame()`, `stopAll()`, the dgram socket, RWS graceful-stop signal,
status color conventions — none of that changes). Two changes:

1. **Add an Action dropdown**, matching `gofa-motor`/`gofa-rapid-exec`'s exact idiom
   (`nodes/gofa-motor.html:4-8,20-25`, `nodes/gofa-motor.js:6,10-13`):
   - HTML `defaults`: add `action: { value: 'start' }`, plus a `<select>` with two `<option>`s
     (`start` → "Start EGM", `stop` → "Stop EGM").
   - JS: `this.action = config.action || 'start';` at construction, and in the input handler,
     resolve the effective action the same way `gofa-motor.js`/`gofa-rapid-exec.js` do:
     ```js
     var raw = msg.payload;
     var action = (typeof raw === 'string' && raw) ? raw.toLowerCase()
                : (raw && raw.action) ? String(raw.action).toLowerCase()
                : node.action;
     ```
     This is a superset of today's behavior (bare `"start"`/`"stop"` strings still work as an
     override) — existing flows that already send those strings keep working unchanged; new
     flows can also just use a bare inject against a pre-configured node instance.

2. **Remove the joint-array branch entirely** from the input handler (`gofa-egm.js:373-387`) —
   that logic and its validation move to `gofa-egm-move`. Replace all reads/writes of
   `node._streaming`/`node._target`/`node._baseline` with `node.robot._egmActive`/
   `node.robot._egmTarget`/`node.robot._egmBaseline`:
   - `bindSocket()`'s first-frame handler sets `node.robot._egmActive = true` (was
     `node._streaming = true`, `gofa-egm.js:275`) and captures baseline+target onto the robot
     object (was `gofa-egm.js:226-229`).
   - `onFrame()`'s echo-send reads `node.robot._egmTarget` instead of `node._target`
     (`gofa-egm.js:231`) — this is the one place `gofa-egm-move`'s writes actually take effect;
     no polling or event needed, the next UDP frame (~24ms later) just picks up whatever value
     is currently there.
   - `stopAll()` clears `node.robot._egmActive = false`, `node.robot._egmTarget = null`,
     `node.robot._egmBaseline = null` (was `gofa-egm.js:207-215`).
   - `node._socket`, `node._starting`, `node._lastEmit` stay node-local (only the node that owns
     the socket ever touches them — no cross-node need). `node._stopped` stays as-is (already
     effectively write-only today; not worth touching in this change).
   - Help text (`gofa-egm.html`'s `<h3>Input</h3>` section, `gofa-egm.html:95-104`): drop the
     joint-array bullet, document the Action dropdown + override instead, and add a pointer to
     `gofa-egm-move` for setting targets.

Output/telemetry behavior is unchanged — still throttled `node.send()` of
`{ok, joints, seqno, mciState, motorsOn, convergence, source:'egm'}` on every frame, still on
this node (it's the one with the open socket).

### New node: `gofa-egm-move` (`nodes/gofa-egm-move.js` + `.html`)

Config: `robot` (required, typed `gofa-robot` ref), `name`. No action dropdown — this node does
exactly one thing. `inputs: 1, outputs: 2`, with `outputLabels: ['target sent', 'EGM not active (fallback)']`
— same multi-output idiom as `gofa-sequencer.js` (`nodes/gofa-sequencer.js:76,87,100,107`,
build a `[msgOrNull, msgOrNull]` array and call `node.send([...])` once).

Input handling (this is `gofa-egm.js`'s current joint-array validation block,
`gofa-egm.js:373-387`, relocated and adapted):
```js
var payload = msg.payload;
var joints = Array.isArray(payload) ? payload
           : (payload && Array.isArray(payload.joints)) ? payload.joints
           : null;
if (!joints || joints.length !== 6 || joints.some(function(j) { return typeof j !== 'number' || !isFinite(j); })) {
    node.error('gofa-egm-move: msg.payload must be a 6-number joint array or {joints:[...]}', msg);
    node.status({ fill: 'red', shape: 'ring', text: 'bad target' });
    return done();
}
if (!node.robot) { ... error, done(); }

if (node.robot._egmActive) {
    node.robot._egmTarget = joints;
    msg.payload = joints;           // normalize to a bare array — see below
    node.status({ fill: 'green', shape: 'dot', text: 'target set' });
    node.send([msg, null]);
} else {
    msg.payload = joints;           // normalize here too, so the fallback output is ready to use
    node.status({ fill: 'yellow', shape: 'ring', text: 'EGM not active — fallback' });
    node.send([null, msg]);
}
done();
```

**Why normalize `msg.payload` to a bare `[j1..j6]` array on both outputs**: checked
`gofa-movej.js:13-15` — it accepts a bare 6-element array directly (`Array.isArray(msg.payload)
&& msg.payload.length === 6`), but does **not** understand `{joints:[...]}` (only a bare array or
a `{j1..j6}` object, `gofa-movej.js:16-22`). Normalizing to a bare array on the way out means the
fallback output can be wired **directly** into `gofa-movej` with zero `change` node in between —
this is the natural fallback pairing (EGM target lost → fall back to a normal absolute-joint TCP
move) and it's worth making it work out of the box.

Help text should state this explicitly: "Output 2 (fallback) carries the same target as a bare
`[j1..j6]` array — wire it straight into `gofa-movej` for an automatic non-EGM fallback."

Icon/color: reuse `category: 'ABB-GoFa-12', color: '#D3740C', icon: 'white-globe.svg'` — same as
`gofa-egm.html` and `gofa-movej.html` (this palette doesn't use per-feature icon/color families,
confirmed by checking `gofa-movej.html:3,9`).

### Registration

- `package.json`: add `"gofa-egm-move": "nodes/gofa-egm-move.js"` under `node-red.nodes`, next to
  the existing `gofa-egm` entry.

### Tests (`test.js`)

- Move the joint-array-target tests currently under the `gofa-egm` section (per-existing test
  names: "a joint-array target before start is rejected", "a malformed joint array...",
  "an unrecognized payload shape...") to a new `gofa-egm-move` section, updated to assert against
  `mockRobot._egmActive`/`mockRobot._egmTarget` instead of node-local fields, and to check
  `node.send([...])` was called with the message on the correct output index for both the
  active and fallback branches.
- Add a new test: EGM active (`mockRobot._egmActive = true`) + valid target → output 1 gets
  `{payload:[...]}`, output 2 is `null`, `mockRobot._egmTarget` updated.
- Add a new test: EGM inactive (`mockRobot._egmActive = false`, default) + valid target →
  output 2 gets `{payload:[...]}`, output 1 is `null`, `mockRobot._egmTarget` untouched.
- Update the remaining `gofa-egm` tests (start/stop/close) wherever they currently assert
  `node._streaming`/`node._target`/`node._baseline` to assert `mockRobot._egmActive`/
  `mockRobot._egmTarget`/`mockRobot._egmBaseline` instead — check `test.js`'s existing
  `mockRobot`/harness for the `gofa-sequencer`/`gofa-stop-seq` tests first, since it must already
  support arbitrary `_xyz` fields on the mock robot object for that pattern to be testable, and
  reuse the same approach.
- Add the new Action-dropdown resolution test for `gofa-egm` itself (bare inject uses
  `config.action`; `msg.payload` string/`.action` still overrides it) — same shape as whatever
  test already exists for `gofa-motor`'s equivalent resolution logic, if one does; otherwise a
  small new one mirroring it.
- Run `node test.js` and confirm all pass before touching docs/flows.

### Docs and demo flow updates

- `nodes/gofa-egm.html`: update per above (Action dropdown docs, drop joint-array section, point
  to `gofa-egm-move`).
- New `nodes/gofa-egm-move.html` help text: what it does, the two outputs, the `gofa-movej`
  fallback-wiring tip, and that it requires an already-running `gofa-egm` session to do anything
  on output 1 (mirrors `gofa-egm.html`'s existing prerequisites section for context, doesn't need
  to repeat the full MainModuleEGM.mod/UDPUC setup — link to `gofa-egm`'s help instead).
- `README.md` (root) EGM section: node table gets a `gofa-egm-move` row; the `msg.payload`
  examples update to show the Action-dropdown + bare-inject style for start/stop, and the target
  example moves to `gofa-egm-move` with the fallback-to-`gofa-movej` tip.
- `node-red-contrib-abb-gofa/README.md` (npm-facing): same EGM section updates.
- `CLAUDE.md`: update the `gofa-egm` line in the Nodes table description (now session-control
  only) and add a `gofa-egm-move` row; update the EGM section's Node.js-side paragraph to reflect
  the split and the new `robot._egm*` shared-state fields (following the existing
  `_seqStop`/`_seqRunning` documentation style already in this file, if any, or just add a short
  note next to the `gofa-egm` description).
- `flows/gofa_demo_flow.json` (and its synced npm copy
  `node-red-contrib-abb-gofa/examples/gofa_demo_flow.json`, keeping that copy's genericized
  IP/username as usual) — restructure the "4 - EGM (UDP)" → "1 - EGM Session (UDP)" subgroup:
  - Replace the current single `gofa-egm` node fed by two string-payload injects with **two**
    `gofa-egm` node instances, `action: 'start'` and `action: 'stop'`, each fed by its own bare
    date-payload inject — mirrors the `gofa-motor` Motors ON/OFF pattern exactly.
  - Add a `gofa-egm-move` node instance, fed by the existing sine-sweep function node (unchanged
    logic — it already emits a bare `[j1..j6]` array), with output 1 → the existing feedback-style
    debug node and output 2 → wired into a real `gofa-movej` node instance (demonstrating the
    fallback actually works, not just documented) plus its own debug node.

## Verification

1. `node test.js` — new and updated tests pass (0 failures), confirms the shared-state
   mechanism, both `gofa-egm-move` output branches, and the Action-dropdown resolution logic
   work at the unit level.
2. `/robot-status` preflight, confirm `MainModuleEGM.mod` is the currently loaded module (or
   swap it in via the existing `gofa-rapid-exec` unloadmod/loadmod sequence in the demo flow —
   unchanged by this task).
3. Live: `gofa-egm` (action `start`) via a bare inject → confirm session starts exactly as
   before (status "streaming (holding)", telemetry flowing).
4. Live: `gofa-egm-move` with a small joint offset while the session is active → confirm output
   1 fires, real motion happens (same as today's direct-payload behavior), `robot._egmTarget`
   updates each call.
5. Live: `gofa-egm` `stop` (bare inject) → confirm session ends exactly as before (graceful
   TRAP/`EGMStop` exit, no RAPID stop).
6. Live: with EGM **not** active (fresh redeploy, no `start` sent yet), send a target into
   `gofa-egm-move` → confirm output 2 fires instead of output 1, and that wiring output 2
   straight into `gofa-movej` actually moves the robot via the normal TCP path — this is the
   core new behavior the user asked for and the one prior live testing never covered.
7. Confirm `gofa-egm`'s own direct joint-array payloads (the old contract) are now rejected/no
   longer handled by that node — i.e. the breaking change is real and intentional, not an
   accidental dual-path.
