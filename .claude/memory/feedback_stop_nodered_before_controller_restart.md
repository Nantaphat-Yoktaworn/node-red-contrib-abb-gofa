---
name: stop-nodered-before-controller-restart
description: "Stop Node-RED before restarting the ABB controller, or FlexPendant can get locked out with \"too many device login\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2f64e6a9-091c-4e62-9754-fb842fcfe391
---

Always stop Node-RED (or at least redeploy/disable flows using `gofa-robot`) **before** restarting the controller. Confirmed live 2026-07-06: leaving Node-RED running through a controller restart caused FlexPendant login to fail with "too many device login"; stopping Node-RED then restarting the controller again fixed it and FlexPendant logged in normally afterward.

**Why:** `gofa-robot.js`'s `createRobotClient()` never calls RWS `GET /logout` anywhere (confirmed via grep across the whole repo) — sessions are only ever acquired (Basic-Auth login on first request or after a 401) and never explicitly released. The controller has a documented hard session cap (`abb-rws` skill, verified against ABB docs): **max 70 RWS sessions total, but only 19 if any WebSocket subscriptions are active.** `gofa-subscribe-state`/`gofa-subscribe-io` hold live WS subscriptions, so a Node-RED instance running these (as `dashboard_flow.json`, `gofa_demo_flow.json`, and `teach_workflow_flow.json` all now do) counts against that lower 19-session ceiling. Every Node-RED restart/flow redeploy creates a fresh `createRobotClient()` closure (cookie reset) and thus a fresh session on next use, while old sessions from before the redeploy are never cleanly logged out — they just sit until the controller's own session timeout. Repeated redeploys during iterative development, or Node-RED reconnecting/re-authenticating the instant RWS comes back up mid-boot (racing FlexPendant for a session slot), can exhaust the pool.

**How to apply:** Before instructing a controller restart (or before doing one live-test-adjacent), proactively remind to stop Node-RED first, especially if `gofa-subscribe-io`/`gofa-subscribe-state` nodes are deployed anywhere. **Fixed 2026-07-06** (commit `f114cd0`): `createRobotClient()` in `gofa-robot.js` now has a `logout()` that GETs `/logout` with the session cookie and clears it, and `GoFaRobotNode` calls it from its `close` handler — sessions now release on every redeploy/stop instead of leaking until the controller's 5-minute inactivity timeout. Still worth stopping Node-RED before a controller restart as a precaution (this only fixes leaks from *this* client's own redeploys, not e.g. other tools/sessions), but the main leak source is closed. See [[project_robot_live_test_log]] for other live-test findings on this controller.
