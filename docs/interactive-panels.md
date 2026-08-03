# Interactive properties panels (2.2.0+)

Since 2.2.0, every non-config node's properties dialog has live-action buttons ("Jog Now", "Read Value", "Test Connection") calling the real robot directly from the editor, independent of deploy state — a separate code path from `node.on('input')`.

- Wired in `oneditprepare` via `$.ajax`/`$.getJSON` against `RED.httpAdmin.get/post('/gofa-<node>/:id/<action>', RED.auth.needsPermission(...), ...)`. Looks up the robot config node via `RED.nodes.getNode(req.params.id)`, calls `robot.socketSend(...)`/`robot.rwsGet/rwsPost(...)` directly.
- **Never calls the node's own `send()`** — nothing propagates downstream, even in a deployed flow.
- Read-only routes (`.read`) gated by bare `needsPermission` (grants nothing with no `adminAuth` configured, but they only read). **State-changing routes (`.write`, 23 endpoints) gated by `requireAdminAuth(RED, 'gofa-<node>.write')` (`nodes/lib/require-admin-auth.js`, 2.4.10)** — delegates to `needsPermission` when `adminAuth` is configured, else returns **403** (closing the old hole: an unauthenticated editor port could previously trigger motion via a bare request). Escape hatch: `gofa-robot`'s **Allow insecure live control** checkbox falls through to `next()` even with no `adminAuth`, for cells relying on network isolation. Confirmed by repo-wide grep: every `.write` endpoint is guarded.
- Cross-node shared state (`gofa-sequencer`'s `_seqRunning`/`_seqStop`) is genuinely shared between a panel run and a deployed-flow run of the same node type on the same config node.
- `gofa-sequencer`'s panel **Stop Sequence** stays always-enabled regardless of polled status (2.2.2 fix — a kill switch shouldn't disable itself right when needed); only **Start** is gated on polled status (server also rejects concurrent starts regardless).

# Known Signals dropdown (2026-07-21)

`gofa-di-read`, `gofa-do-write`, `gofa-grip`, `gofa-subscribe-io` each have a **Known Signals** `<select>` above the free-text Signal field, populated live from `GET /rw/iosystem/signals` via a per-node admin route. First option is always `Other (type below)` (no-op). Picking a signal copies its name into the same editable text field. Filters: `gofa-di-read`→DI, `gofa-do-write`/`gofa-grip`→DO, `gofa-subscribe-io`→unfiltered. XHTML `<li class="ios-signal-li">` parsing extracted into shared `nodes/lib/list-signals.js` (used by `gofa-io-list.js` too).

**Race-condition fix (caught by review before shipping)**: dropdown re-populates on every Robot-field change; original code only cleared the `<select>` once, synchronously, not again when the response landed — two overlapping populate calls could each append into the same list, producing duplicates. Fixed by re-clearing inside `.done()` too.
