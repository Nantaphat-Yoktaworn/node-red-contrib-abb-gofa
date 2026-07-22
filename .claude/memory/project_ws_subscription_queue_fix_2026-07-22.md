---
name: project_ws_subscription_queue_fix_2026-07-22
description: "queueSubscription() fix for a live-confirmed race where two concurrent gofa-subscribe-* nodes get an HTTP 500 on WS upgrade; DONE, live-verified, committed+pushed (785e16d)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c3ad5884-614a-4372-8430-123de6636ecb
  modified: 2026-07-22T02:24:45.834Z
---

**STATUS: DONE.** Live-tested by user 2026-07-22 — both subscribe nodes connect cleanly, no
more HTTP 500. Committed as two commits (81007d3 gofa-egm stop-transport reporting, 785e16d the
queue fix itself) and pushed to origin/main.

**Bug (live-confirmed by user 2026-07-22)**: a flow with two `gofa-subscribe-io` nodes both
auto-injecting at deploy time — subscribing to two different I/O signals — reliably gets

```
GoFa WebSocket subscription error: WebSocket upgrade rejected: HTTP 500
```

on one of the two. Reproduced twice with different signal pairs (`Asi1Button1`/`Asi1Button2`,
then `Asi1Button2`/`ABB_Scalable_IO_0_DO6`) — not signal-specific, a pure timing/concurrency
issue. Root cause: `gofa-subscribe-io`/`-state`/`-elog` all independently fire
`POST /subscription` + a WS upgrade against the ONE shared RWS session on a `gofa-robot` config
node, with zero coordination between node instances. An earlier, different race on the same code
path (shared `cookie` variable clobbered between one node's POST response and its own later
WS-connect) was already fixed via same-callback cookie capture in `requestRawOnce` — this is a
separate failure mode the controller itself produces when two subscription-creation attempts on
one session overlap in time.

**Fix**: `queueSubscription(fn)` added to `createRobotClient()` in
`node-red-contrib-abb-gofa/nodes/gofa-robot.js` (also exposed on `GoFaRobotNode.prototype`) — a
plain promise-chain queue that serializes subscription-CREATION attempts (POST through WS
reaching `open`/`error`/`close`) per robot config node, without blocking already-open
subscriptions from streaming concurrently afterward. All three subscribe node files
(`gofa-subscribe-io.js`, `-state.js`, `-elog.js`) wrap their POST-then-WS-connect logic in a
`performSubscribe` function and route it through `robot.queueSubscription(performSubscribe)`
when available, falling back to calling it directly if not (keeps existing mock-robot tests in
`test.js`, which don't expose `queueSubscription`, working unchanged).

**How this shipped**: diagnosed by reading `gofa-robot.js`'s session/cookie code myself, then
delegated the fix design to `agy` (`Gemini 3.5 Flash (High)`, per
[[feedback_agy_model_choice]]). agy went further than the prompt asked (which requested a
diagnosis + exact code to apply by hand) and directly edited `gofa-robot.js` +
`gofa-subscribe-io.js` in the live working tree — see
[[feedback_agy_writes_files_without_edit_authorization]] for that finding. The applied diff
matched what agy reported in text, verified via `git diff`. Reviewed the logic, ran the full
test suite (290/290 passed, no regressions), then added 2 new regression tests myself (agy
hadn't added any): a `createRobotClient: queueSubscription` ordering test and a
`gofa-subscribe-io` integration test confirming it routes through `robot.queueSubscription` when
available. Then manually applied the identical pattern to `gofa-subscribe-state.js` and
`gofa-subscribe-elog.js` (agy was deliberately scoped to `-io.js` only, to confirm the pattern
first). Final state: 292/292 tests passing.

**NOT yet live-verified** — no live robot access in this session. The fix is a client-side
concurrency serialization; it should eliminate the race by construction (the controller never
sees two `POST /subscription` in flight at once from this palette anymore), but confirming it
actually resolves the real HTTP 500 needs testing against the live controller with the same
two-node auto-inject flow that originally reproduced it.
