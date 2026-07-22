---
name: project_source_transport_reporting_audit_2026-07-22
description: "audit of every node with an automatic (non-user-selected) communication fallback, to make each report which transport it actually used — DONE, committed (81007d3)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c3ad5884-614a-4372-8430-123de6636ecb
  modified: 2026-07-22T02:38:34.239Z
---

User asked for every node with a fallback/alternate communication path to report which one it
actually used, for easier debugging. Delegated the audit to `agy` (this predates the model-lock
— used `Gemini 3.1 Pro (High)` here, `Gemini 3.5 Flash (High)` for everything after; see
[[feedback_agy_model_choice]]).

**Audit result — only genuine automatic (code-decided) fallbacks count, not user-selected
Transport dropdowns:**
- `gofa-subscribe-io.js` (WS → 500ms polling) — already reported `source: 'ws'/'poll'/'oneshot'`. No change needed.
- `gofa-rapid-var-read.js` (socket GETVAR → module-text) — already reported `source: 'socket'/'module-text'` (+`stale: true`). No change needed.
- `gofa-egm.js`'s `setStopSignal()` (RWS `/set-value` → background-task socket `setdo`, used by
  the `stop` action) — **did NOT report anything**; the `stop` action emitted no output payload
  at all (fire-and-forget). This was the one real gap.
- Not in scope, correctly excluded: `gofa-leadthrough.js`'s `clearQueuedMovesIfRunning` (an
  optimization/skip, not a transport fallback), `gofa-subscribe-var.js` (only one path, no
  fallback), `gofa-do-write.js`/`gofa-asi-led.js` (manual Transport dropdown, user-selected).

**Fix applied directly (small, ~10 lines, not delegated)**: `setStopSignal()` now resolves with
`'rws'` or `'socket'` depending on which transport actually wrote the signal; `stop()` threads
it through; the `stop` action's input handler now emits `msg.payload = { ok: true, source }`
instead of nothing. 290/290 tests passed after. Committed `81007d3`, pushed same session as part
of the broader `main` push that also included the WS subscription queue fix — see
[[project_ws_subscription_queue_fix_2026-07-22]].

Published as part of `2.4.8` (npm), same session.
