---
name: feedback-grep-all-nodes-after-shared-internals-refactor
description: "After refactoring gofa-robot.js's private internals, grep every file in nodes/ for the old field names before calling it done"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 58ab807b-429c-4693-a7f1-105ef986edca
---

When `gofa-robot.js`'s internal shape changes (fields renamed, moved into a private closure, methods added/removed), grep the **entire** `nodes/` directory for the old private field names before considering the refactor complete — not just the node you were actively working on.

**Why:** the `check-status.js` refactor (commit `4f67801`) moved session/cookie state (`_getSession`, `_cookie`, `_request`) out of `GoFaRobotNode` into a private `createRobotClient()` closure, and updated the nodes that were top-of-mind at the time. It missed four other node files that reached into those same private fields with their own hand-rolled `https`/`http` request logic: `gofa-upload-mod.js` (caught live first, fixed in commit `00dff1a`), then `gofa-subscribe-io.js`, `gofa-subscribe-state.js`, and `gofa-file-read.js` (all caught in one follow-up bug report and fixed together in commit `3d8243c`). All four broke identically — `TypeError: robot._getSession is not a function` — and all four went undetected by the existing mocked test suite, because no test used a robot mock that only exposed the *public* API; each node's own private-field access was invisible to its tests until it ran live.

**How to apply:**
1. Any time `gofa-robot.js`'s private fields/methods change, run `grep -rln "_getSession\|_cookie\|_request(" node-red-contrib-abb-gofa/nodes/` (or whatever the old names were) across the whole `nodes/` directory — not just the files you intended to touch — before considering the refactor finished.
2. When fixing a node that reached into private robot internals, prefer adding a shared low-level primitive to `gofa-robot.js` (e.g. `requestRaw()`/`getCookie()`, added in `3d8243c` for raw header/binary access) over re-hand-rolling another one-off `https`/`http` request in the node file — duplicated raw-request code is exactly what goes stale and breaks silently the next time the shared internals change.
3. When adding a mocked test for a node that talks to the robot, build the mock robot object from only the methods the *real* `GoFaRobotNode` exposes (`rwsGet`/`rwsPost`/`rwsPut`/`rwsPostHal`/`withMastership`/`socketSend`/`requestRaw`/`getCookie`) — never add private fields like `_cookie`/`_getSession` to the mock just to make a test pass, since that's exactly the gap that let all four of these regressions ship undetected.

See [[project-robot-live-test-log]] for the live verification of both fixes.
