---
name: project-output-payload-checkbox
description: "Output payload checkbox feature (2026-07-15) — implemented, live-verified across all 42 nodes; design details for future changes"
metadata: 
  node_type: memory
  type: project
  originSessionId: 13ffd05a-32a0-4689-8d62-b5ee7b0f1152
---

Added an "Output payload (debug)" checkbox (`config.outputPayload`, default **unchecked/false**)
to all 42 palette nodes (everything except the `gofa-robot` config node). Unchecked (the new
default): the node still fires its output message to trigger the next node in the flow, but the
message carries no payload — just `{_msgid}` — instead of the full debug data every node used to
always emit. Checked: behaves exactly as before (full `msg.payload`). Motivation: the user didn't
want to insert a `change` node after every node just to silence debug clutter mid-flow.

**Mechanism**: `nodes/lib/gate.js` wraps whatever `send` function a node already had.
`gate(config, send)` returns a function that strips the outgoing msg to `{_msgid}` unless
`config.outputPayload` is true (checked live at call time, not cached — so mutating
`config.outputPayload` on an existing node instance takes effect on the next send). Handles both
a single message and the 2-output array form (`send([msg, null])`, used by `gofa-egm-move`).

**Wiring, one line per node** (no per-call-site edits needed): for nodes using the input
handler's `send` param, `send = gate(config, send);` as the first statement inside
`node.on('input', function(msg, send, done) {` — every existing `send(msg)` in that closure
(including nested helpers that close over the same `send` variable, e.g. `gofa-sequencer`'s
`runStep`) is automatically gated. For the 6 push-style nodes that call `node.send(...)` directly
from async callbacks outside the input handler (`gofa-egm`, `gofa-subscribe-elog`,
`gofa-subscribe-io`, `gofa-subscribe-pose`, `gofa-subscribe-state`, `gofa-subscribe-var`):
`node.send = gate(config, node.send.bind(node));` right after `var node = this;`. Both wiring
patterns coexist in those 6 files since the input-handler `send` and `node.send` are different
function references.

**Deliberately untouched**: `node.error(...)`/`node.status(...)` — only the outgoing wire message
is gated, so the Node-RED error/debug sidebar still shows full detail regardless of the checkbox.
`gofa-robot` is excluded (config node, no wire output).

**Implementation was delegated to a fork** (mechanical, 42×2 files) — it self-caught and fixed
one bug mid-run: the first codemod pass wrote the Pattern-B wiring as
`node.send = function(msg){ _rawSend(gate(config, msg)); }` (wrong — treats `msg` as the `send`
callback), corrected to `node.send = gate(config, _rawSend);`. Final: 226/226 unit tests pass.

**Live-verified 2026-07-15** against the real robot (192.168.1.103) via a fake-RED harness
script (same pattern as `test.js`'s `loadNodeType`/`runInput`, but wired to the real controller
instead of a mock server) — 41/44 individual checks passed on the first clean run; the 3
apparent failures (`gofa-subscribe-state`, `gofa-subscribe-io`, `gofa-subscribe-var` checked)
were a **test-harness bug, not a real defect**: those nodes call `done()` synchronously before
their async RWS `.then()` callback actually fires `node.send(...)`, so the harness read
`node.sent` too early. Not re-verified after fixing the wait timing because the robot's socket
server went unresponsive mid-run — see [[project_socket_server_stuck_2026-07-15]] for that
separate, unrelated incident. The checkbox mechanism itself was still fully confirmed on every
node that DID get a live output, including error paths (timeouts/403s still correctly produced
`default-state output={}` and a full payload when checked) — gating is provably independent of
whether the underlying command succeeds.

**Motion-node test strategy** (worth reusing for future live-test sessions): don't double up
physical robot motion just to re-prove an already-working code path. For the 6 true
motion-triggering nodes (`gofa-jog`, `gofa-joint-jog`, `gofa-movej`, `gofa-move`,
`gofa-go-point`, `gofa-sequencer`), only the new default-unchecked (stripped) behavior was fired
live once each — the checked/passthrough path for those reuses the *same* message-building
logic already covered by the mocked unit suite and prior documented live-test history, so it
wasn't worth a second physical move just for this feature.

**Icon change same session (unrelated feature, also delegated to a fork)**: all 43 nodes
(including `gofa-robot` this time) now reference a custom `nodes/icons/gofa.svg` instead of
Node-RED's built-in `white-globe.svg`/`light.svg`, copied in from
`C:\Users\anapa\Downloads\node-icon.svg`.

**New node added after v1.5.0 shipped**: `gofa-connection-status` (`nodes/gofa-connection-status.js`)
checks RWS (4 independent calls) and the socket ping independently, has the checkbox from day
one, and — unlike `gofa-status` — never raises a Node-RED error on a degraded/unreachable
result (it's a successful check either way), so it's safe to poll on a timer without spamming
the debug/error sidebar. Registered in `package.json`, documented in `README.md` and
`CLAUDE.md`'s node table (now 44 nodes total). 231/231 unit tests pass. Not yet wired into any
example flow (`dashboard_flow.json`/`gofa_demo_flow.json`) — not asked for, YAGNI'd.
