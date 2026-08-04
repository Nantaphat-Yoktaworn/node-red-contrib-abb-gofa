# Bugfix checklist — repo scan 2026-08-04

Seven confirmed bugs found by a full read of `node-red-contrib-abb-gofa/nodes/`.
Ordered by impact. Line numbers are as of commit `ddf7852`.

Baseline at time of scan: `node test.js` → **293 passed, 0 failed**; `rapid/*.mod`
drift check clean. None of the seven were caught by the existing suite — see
[Cross-cutting](#cross-cutting-follow-ups) for why.

**Status: 1, 2, 3, 4, 6 fixed, bench-verified AND live-verified** against the
controller at `192.168.20.43` on 2026-08-04. `node test.js` → **301 passed, 0
failed**; each fix was reverted in turn to confirm its test actually fails
without it. See [Live verification](#live-verification-2026-08-04).

**5 and 7 remain open** — 5 needs a behavioral decision, 7 wasn't in scope.

---

## 1. `gofa-setup`: `node.status` passed unbound — T_LED reload never runs

- **File:** `node-red-contrib-abb-gofa/nodes/gofa-setup.js:289`
- **Severity:** High — silent loss of a whole setup step
- **Affects:** deployed `gofa-setup` node only (the admin route passes `null` and works)

```js
return prepareLed(r, steps, node._t, node.status).then(function(prep) {
```

`prepareLed` invokes it bare as `onStatus({...})` (line 70). The real runtime's
`Node.prototype.status` is `this._flow.handleStatus(this, status)` — verified in
the installed copy at
`@node-red/runtime/lib/nodes/Node.js:623`. Unbound, `this` is not the node, so it
throws a `TypeError` on the **first** LED step. The `.catch` at line 112 swallows
it into `pushStep('stop T_LED', false, "Cannot read properties of undefined
(reading 'handleStatus')")` and returns `{present: false}`, so `finishLed()` also
no-ops.

Net effect: whenever `T_LED` exists on the controller, the deployed node skips the
entire BackgroundLed reload and reports a cryptic TypeError as the reason.

- [x] Change to `node.status.bind(node)` — `gofa-setup.js:295`
- [x] Add a regression test that fails without the bind (needs the mock fix in
      [Cross-cutting](#cross-cutting-follow-ups) — the current mock closes over
      `node` instead of using `this`, which is exactly why this bug was invisible)
- [x] Live-verified 2026-08-04: all 6 T_LED steps ran and passed —
      `stop T_LED / ok:true` … `confirm T_LED started / ok:true` …
      `ping T_LED (background port) / ok:true (module v2.5.1)`

---

## 2. `gofa-setup`: editor-panel path uses exact version equality

- **File:** `node-red-contrib-abb-gofa/nodes/gofa-setup.js:478`
- **Severity:** Medium — false "version mismatch" warning
- **Affects:** editor-panel Setup button only

```js
if (ver === PALETTE_VERSION) return 'OK (module v' + ver + ')';
```

Every other call site uses `versionsCompatible()` — `gofa-setup.js:321`, and
`gofa-connection-status.js:65/67/158/160`. Per that helper's own comment, patch
releases never change the socket protocol and must **not** nag. This duplicated
copy in the admin route was missed when the helper was introduced, so the panel
falsely warns "module reports v2.5.0, palette expects v2.5.1" for a module that is
perfectly fine.

- [x] Replace with `versionsCompatible(ver, PALETTE_VERSION)` — `gofa-setup.js:481`
- [x] Add a test covering the admin route (see
      [Cross-cutting](#cross-cutting-follow-ups) — admin routes are currently
      untested; the mock discards every handler)
- [x] Live-verified 2026-08-04: patch drift (2.5.2) reports OK, minor drift
      (2.6.1) still warns
- [x] Extracted — `runSetup()` is now the single implementation so the two paths cannot
      drift again (see [Cross-cutting](#cross-cutting-follow-ups))

---

## 3. `gofa-file`: upload skips the path escaping download/delete apply

- **Files:** `node-red-contrib-abb-gofa/nodes/gofa-file.js:145` (runtime),
  `:278` (admin route)
- **Severity:** Medium — inconsistent, breaks on ordinary paths

`escapedPath` is computed at line 47 and used by `download` and `delete`, but
`upload` builds its URL from the raw value:

```js
var urlPath = '/fileservice/' + remotePath;   // line 145 — should use escapedPath
```

A remote path containing a space, `#`, or `?` works for two of the three actions
and breaks on the third.

- [x] Use `escapedPath` in the runtime upload branch (`gofa-file.js:148`)
- [x] Use `escapedPath` in the admin upload branch (`gofa-file.js:281`)
- [x] Live-verified 2026-08-04: `%20` accepted, file lands with a literal space,
      content round-trips, no double-encoding. A RAW space is rejected
      **client-side** by Node (`Request path contains unescaped characters`) —
      so pre-fix this threw before reaching the controller.
- [x] Audited and fixed — every fileservice caller now uses `escapeFileservicePath()`. Original note: for the same gap:
      `gofa-setup.js:269`/`:430`, `gofa-mod-edit.js:94`/`:179`,
      `gofa-robot.js:648` (`remoteSavePoints`). **Now known to be a real latent
      bug**, not just an inconsistency — `remoteSavePoints` builds its URL from
      the user-configurable `remotePointsPath`, so a points path containing a
      space throws client-side.
- [x] Add a test with a space in the remote path (both runtime + panel)

---

## 4. `gofa-asi-led`: close handler doesn't invalidate the blink session

- **File:** `node-red-contrib-abb-gofa/nodes/gofa-asi-led.js:107-121`
- **Severity:** Medium — post-close timer + double `done()`

The handler clears `_blinkTimer` and calls `_activeBlinkDone()`, but never bumps
`node._blinkSession`. An in-flight `ledWrite()` promise that resolves *after* close
still passes the `node._blinkSession !== currentSession` guard, so it:

1. re-arms `node._blinkTimer` (line 206) on a torn-down node, and
2. can call `done()` a second time → Node-RED "done called more than once".

The `on('input')` handler already does the right thing at line 132
(`node._blinkSession = (node._blinkSession || 0) + 1`); the close handler just
needs the same.

- [x] Bump `node._blinkSession` in the `close` handler, before calling
      `_activeBlinkDone()` — `gofa-asi-led.js:119`
- [x] Add a test: start a blink, close mid-flight, assert no timer is re-armed and
      `done()` fires exactly once

---

## 5. `gofa-movej`: malformed payload silently moves to the *configured* pose

- **File:** `node-red-contrib-abb-gofa/nodes/gofa-movej.js:20-46`
- **Severity:** Medium — wrong failure mode for a motion node
- **Decision needed:** see below

```js
if (Array.isArray(msg.payload) && msg.payload.length === 6) { j = msg.payload; }
else if (typeof msg.payload === 'object' && !Array.isArray(msg.payload)) {
    if (p.j1 !== undefined) { j = [p.j1, ...]; } else { j = null; }
} else { j = null; }

if (!j) { j = JSON.parse(node.joints); }   // ← falls back and MOVES
```

A 5-element array, or an object without `j1`, sets `j = null` and falls through to
the node's configured joints — then executes the move. The array-length and `j1`
validation at lines 48-61 can never fire on those inputs.

Treating *no* payload (an inject timestamp) as "use the configured joints" is
clearly intended and should stay. Treating *supplied but malformed* the same way
is not.

- [x] **Decided:** error on malformed. Absent / number / boolean / empty-string still falls back, so inject-triggered flows are unaffected.
      (Recommended: distinguish "absent" from "malformed" — only `null`/`undefined`
      /number/empty-string falls back; a non-empty array of the wrong length or an
      object lacking `j1` errors.)
- [x] Implemented via a shared `resolveJointsPayload()`
- [x] Mirrored — both paths call the same resolver; admin route (`:119-121`), which already rejects
      wrong-length arrays with a 400 — the two paths currently disagree
- [x] Tests added for: 5-element array, 7-element array, object without `j1`,
      and confirm the inject-timestamp path still uses the configured joints

---

## 6. Subscribe nodes: WS reconnect leaks the previous RWS subscription

- **Files:** `gofa-subscribe-io.js:125-136`, `gofa-subscribe-state.js:85-93`,
  `gofa-subscribe-elog.js:109-117`
- **Severity:** Medium — resource leak with a hard controller-side cap

`ws.on('close')` reconnects via `startSubscription()`, which POSTs a fresh
`/subscription` and overwrites `node._pollkey`. The **old** poll key is never
`DELETE`d — only node-close deletes one. On a flaky link these accumulate.

Per the comment in `gofa-robot.js:392-397`, the controller allows only 19
concurrent sessions once any WebSocket subscription is active, and exhausting the
pool locks the FlexPendant out with "too many device login".

- [x] Delete the stale `_pollkey` before re-subscribing (all three nodes)
- [x] Extracted `nodes/lib/drop-subscription.js`, now used by all three nodes on
      both the reconnect and close paths
- [x] Full factoring done — `lib/rws-subscription.js` now owns the subscribe/WS/reconnect lifecycle for all three nodes
- [x] Add a test: force a WS close, assert a `DELETE /subscription/<old-key>` is
      issued before the new POST (one per node type)

---

## 7. `gofa-points`: `doSave` writes the pose without validating it

- **File:** `node-red-contrib-abb-gofa/nodes/gofa-points.js:51-66`
- **Severity:** Low-Medium — silently persists a corrupt point

```js
var p = function(c){ return parseFloat(robot.parseXhtml(body, c)); };
```

`parseXhtml` returns `null` for a class that isn't present, `parseFloat(null)` is
`NaN`, and `JSON.stringify` serializes `NaN` as `null`. A partial or unexpected
robtarget response therefore writes a corrupt point to the on-robot file, which
only fails much later at `gotoObj` ("Point has invalid data (NaN)").

`validatePointsArray()` already exists in this same file (line 23) but is wired
only to `import`.

- [x] Validated the assembled `target` before calling `remoteAddPoint` — reuse the
      same numeric/`isFinite` check `validatePointsArray` uses at line 40
- [x] Returns the `{error: ...}` shape on failure (the caller at line 181 already
      handles it, and the admin route maps it to a 400)
- [x] Test added: robtarget response missing `cf4` → save returns an error instead
      of persisting

---

## Cross-cutting follow-ups

Bugs **2** and **3** are both "the fix landed in one of two copies". Worth
addressing the cause, not just the instances.

- [x] **Admin routes now testable.** `loadNodeType` accepts `opts.routes` to
      capture handlers, driven by a new `runRoute()` helper. gofa-setup and
      gofa-file routes are covered; extending to the rest is still open.
      Original finding: `test.js:52` mocks
      `httpAdmin: { get(){}, post(){}, delete(){} }`, discarding every handler.
      Both bug 2 and bug 3 live in untested admin code. Capture the handlers in
      the mock and drive them with fake `req`/`res`.
- [x] **Mock is now `this`-sensitive.** With it, the three existing "T_LED ..."
      tests fail without bug 1s `.bind(node)` — so bug 1 needs no test of its
      own. Original finding: `test.js:44` is
      `node.status = function(s) { node.statuses.push(s); }` — it closes over
      `node`, so an unbound-`this` bug is undetectable. Changing it to
      `function(s) { this.statuses.push(s); }` catches bug 1 and that whole class.
- [x] **De-duplicated runtime vs. admin paths.** `gofa-setup.js` duplicates ~130
      lines between the two; `gofa-sequencer`, `gofa-rapid-exec`, `gofa-file`, and
      `gofa-connection-status` do the same. `gofa-points.js` already shows the fix
      — a shared `ACTIONS` map both paths call.

## Open items register

Everything still outstanding, consolidated. Nothing below is done.

### A. Blocked on a decision

- [x] **A1 — Bug 5: `gofa-movej` malformed-payload behavior.** Error out, or keep
      the silent fallback to the configured pose? See [section 5](#5-gofa-movej-malformed-payload-silently-moves-to-the-configured-pose)
      for the four sub-tasks that follow once decided. *Safety-relevant: a motion
      node currently moves on bad input.*

### B. Confirmed bugs, not yet fixed

- [x] **B1 — Bug 7: `gofa-points` `doSave` writes an unvalidated pose.**
      `gofa-points.js:51-66`. Three sub-tasks in [section 7](#7-gofa-points-dosave-writes-the-pose-without-validating-it).
- [x] **B2 — Raw fileservice paths elsewhere.** Promoted from bug 3's audit and
      **now known to be a real latent crash**, not cosmetic: a raw space is
      rejected client-side by Node before it reaches the controller
      (live-confirmed 2026-08-04). Affected:
      - `gofa-robot.js:648` `remoteSavePoints` — builds from the **user-configurable**
        `remotePointsPath`, so this is user-reachable
      - `gofa-mod-edit.js:94`/`:179` — user-supplied `path` from the edit dialog
      - `gofa-setup.js:269`/`:430` — fixed `$HOME/Programs/<module>.mod`, lower risk
      - also `gofa-robot.js:636` `remoteGetPoints` (read side, same field)
- [x] **B3 — `gofa-connection-status.js:111`: runtime `Promise.all().then()` has no
      `.catch`.** A throw inside the `.then` body means `done()` is never called
      plus an unhandled rejection. The node is documented "never raises — safe to
      poll" and `watchdog_flow.json` polls it. The admin route (`:183`) has a catch.
- [x] **B4 — `gofa-asi-led.js:90`: `period` lacks the NaN guard `clamp()` has.**
      `{period:"x"}` → `NaN` → serialized as `null` in the SETLED command.
- [x] **B5 — `gofa-rapid-exec.js:137/149/156`: `task` interpolated into the RWS
      path unencoded.** `gofa-setup.js:252` encodes it; `:274` does not. Inconsistent.
- [x] **B6 — `gofa-robot.js:673`: `'p' + Date.now()` point-id collisions.** Two
      points saved in the same millisecond collide. `validatePointsArray` already
      uses the better `baseTime + '-' + i` shape.
- [x] **B7 — `gofa-robot.js:186-192`: `discover()` uncapped socket fan-out.**
      `254 x subnets` concurrent sockets; a host with Docker/WSL/VPN adapters
      easily exceeds 1000 fds. Needs a concurrency cap.

### C. Structural / test coverage

- [x] **C1 — De-duplicate runtime vs. admin paths.** The root cause of bugs 2 and 3.
      `gofa-setup.js` duplicates ~130 lines; `gofa-sequencer`, `gofa-rapid-exec`,
      `gofa-file`, `gofa-connection-status` do the same. `gofa-points.js` already
      shows the fix — a shared `ACTIONS` map both paths call.
- [x] **C2 — Extend admin-route test coverage.** The harness can now capture routes
      (`opts.routes` + `runRoute()`), but only `gofa-setup` and `gofa-file` routes
      are actually exercised. Every other node's admin route is still untested.
- [x] **C3 — Finish factoring the subscribe nodes.** `drop-subscription.js` covers
      the leak, but the subscribe/reconnect/WS-lifecycle logic is still triplicated
      across `gofa-subscribe-io/state/elog`.
- [x] **C4 — Extract the shared ping/version step in `gofa-setup`** so the runtime
      and panel paths cannot drift apart again (this is what caused bug 2).

### D. Repo hygiene / environment

- [x] **D1 — Robot IP drift.** `CLAUDE.md` documents `192.168.1.103`; the robot is
      actually at `192.168.20.43` (whole-subnet change). `flows/*.json` carry three
      *different* stale IPs: `192.168.1.103`, `192.168.20.33`, `192.168.20.37`.
      Update `CLAUDE.md`, the flows, and the `project_robot_current_ip` memory.
- [x] **D2 — `T_GOFA_LED` — NOT a finding; already documented.** Raising this was
      a miss on my part: `docs/background-led-task.md:15` already identifies it as
      ABB's own built-in collaborative-status-light driver (`GOFA_Main`, a SysMod),
      records that its source is deliberately unreadable (`500 "Module encoded,
      noview or readonly"`), and says **do not read/edit/repurpose it** — which is
      exactly why `BackgroundLed.mod` runs in its own `T_LED` task. CLAUDE.md's doc
      table points at that file for this subsystem; I flagged the task as unknown
      without reading it first.

      Live re-confirmation (2026-08-04) is consistent and adds nothing new: our
      `Asi1LedRed/Green/Blue` write held stable for 4.5s, i.e. no contention at the
      **signal** level.

      Note the layer distinction, per `docs/background-led-task.md:21`: the safety
      controller overrides the **physical** LED at hardware level during
      lead-through negotiation and while moving, while the underlying signal values
      hold steady. So "nothing overwrites our values" and "the light may not show
      our colour" are both true simultaneously — that override comes from the
      safety controller, not from `T_GOFA_LED`.
- [x] **D3 — Sync `fs` calls on the Node-RED event loop.** `gofa-points` export/
      import (`fs.writeFileSync`/`readFileSync`) and `gofa-file` download/upload.
- [x] **D4 — Committed** on `fix/repo-scan-2026-08-04` as six grouped commits. Original note: The fix set is 6 node files + `test.js` + new
      `nodes/lib/drop-subscription.js` + this checklist — all working-tree only.
      No branch created, no commit made.
- [x] **D5 — Separate change set from agy (intentional, user-requested): node
      config defaults across the flows.** Not part of the bugfix work — keep it in
      its own commit. One piece of it needs a decision:
      - `nodes/gofa-robot.html` — this is **not** a per-flow default, it's the
        palette-level default that ships to npm in the `files: ["nodes", ...]`
        allowlist. Three values changed:
        - `allowInsecureLiveControl: false` → **`true`**. Per
          `nodes/lib/require-admin-auth.js`, this is the escape hatch that lets the
          editor's live-motion endpoints run with **no adminAuth at all**. Shipping
          it `true` by default disables that guard for every fresh install.
        - `username: 'Default User'` → **`'Admin'`** — this lab's real controller
          account, re-leaked into the public package default.
        - `name: ''` → `'ABB-GoFa-12'` (harmless).

        Setting these in *your flows* is fine and is what was asked for. Setting
        them in `gofa-robot.html` changes what a **stranger installing from npm**
        gets, and undoes the genericization `CLAUDE.md` records as deliberate for
        the 2026-07-08 public release. **Decide:** revert `gofa-robot.html` to the
        generic defaults (flows keep their own values regardless — a flow's saved
        config always wins over the palette default), or keep it and accept that
        the published package ships with the auth guard off.
      - 8 × `flows/*.json` + 8 × `examples/*.json` — **audited 2026-08-04, clean.**
        Semantic diff (parsed JSON, matched by node id) across all 16 files:
        **16 nodes changed, every one of type `gofa-robot`; 0 nodes added or
        removed; no wiring and no other node's properties touched.** The ~16.5k
        line churn is pure re-serialization. All 10 `flows/` (incl. the two
        local-only `_th.json`) and all 8 `examples/` now carry **one identical
        config** — the stated goal, achieved.
        Genuine improvements in the same change: `pointsFile: "points.json"`
        dropped (correct — 2.5.0 removed local point storage), and
        `backgroundPort`/`remotePointsPath` populated where they were missing.

### D6 — Two consequences of the config-node change worth a decision

- [x] **D6a — every flow now points at `192.168.125.1`, not the real robot.** The
      change set replaced the old (already stale) `192.168.1.103` / `.20.33` /
      `.20.37` with ABB's generic service-port default. The flows are now uniform
      but none of them is deployable as-is against `192.168.20.43`. Fine if "match"
      meant "match each other"; not fine if it meant "match the live robot".
      Overlaps with **D1**.
- [x] **D6b — FIXED 2026-08-04.** `prepack.js` now forces the field to `false`
      in every published example; `gofa-robot.html` palette defaults reverted to
      `allowInsecureLiveControl: false` and `username: "Default User"`;
      `examples/` regenerated. New test **"npm surface"** guards all three leak
      paths (shipped example, palette default, and prepack losing the rule) —
      each verified to fail the test when re-broken. `flows/` keeps `true` for
      this lab. Original finding: Verified by applying
      `prepack.js`'s exact regexes to the current flow content: it rewrites
      `"username"` → `Default User` and `"ip"` → `192.168.125.1`, but has **no rule
      for `allowInsecureLiveControl`**, so `true` passes straight through into the
      published examples. A user importing any example flow gets the admin-auth
      guard on live-motion endpoints disabled — and with the same flip now in
      `gofa-robot.html`, a fresh public install has it off in both places.
      Options: revert the field in `flows/`, add a third regex to `prepack.js`, or
      accept it deliberately.
- [x] **D6c — `username: "Admin"` is committed to a public repo.** The npm tarball
      is safe (prepack rewrites it — verified), but the tracked `flows/` and
      `examples/` JSON now carry this lab's real controller account in git history.

---

## Live verification (2026-08-04)

Run against the real controller at `192.168.20.43` (RobotWare 7.21.0+229,
OmniCore C30, `T_LED` present and started). Each test drove the **real node code**
via a live `createRobotClient()`, with a `this`-sensitive `node.status` mock
matching the real runtime.

| Bug | Live result | Evidence |
|-----|-------------|----------|
| 1 | PASS | All 6 T_LED steps ran; `confirm T_LED started`, background-port PING `OK (module v2.5.1)`. Mechanism check confirmed an unbound real-runtime `status` throws `Cannot read properties of undefined (reading _flow)`. |
| 2 | PASS | Panel route: patch drift 2.5.2 → no warning; minor drift 2.6.1 → still warns. Version stubbed (module/palette are in lockstep); rest of the chain real. |
| 3 | PASS | `%20` accepted, literal space in the filename, byte-for-byte round-trip, clean delete, no double-encoding. Raw space rejected client-side. |
| 4 | PASS | Closed ~8ms in against a measured 38-61ms LED round-trip, so the write was genuinely in flight. `done()` once, no timer re-armed, no post-close LED write, chain stopped at 1 write (vs ~16 for 8 blinks). |
| 6 | PASS | 4 reconnects x 3 node types: one DELETE per reconnect, every stale key deleted, controller returned **HTTP 200 to every DELETE**, DELETE always preceded the next POST. `GET /subscription` after 15 cycles → `<ul></ul>`, **0 leftovers**. |

Robot left healthy: motors on, RAPID running, socket OK (59ms), all tasks started.

---

## Execution plan (all remaining A–D items)

Ordered by dependency and risk, not by item number. Rule throughout: **every fix
ships with a test, and every test is verified to fail before the fix** — the method
that proved bugs 1–4/6 were real.

### Phase 0 — decisions (blocking, batched)
Four questions gate the rest: A1 behavior, `flows/` config values (D1/D6a/D6c),
C1 refactor scope, and commit strategy (D4). Everything else proceeds without input.

### Phase 1 — independent bug fixes (low risk, no interdependencies)
Each is self-contained; a regression in one cannot mask another.
1. **B3** `gofa-connection-status` missing `.catch` — restores the "never raises"
   contract `watchdog_flow.json` depends on.
2. **B4** `gofa-asi-led` `period` NaN guard.
3. **B5** `gofa-rapid-exec` encode `task` in the RWS path (+ `gofa-setup:274`).
4. **B6** `gofa-robot` point-id collisions → `baseTime + '-' + i` shape.
5. **B2** escape remaining fileservice paths — `remoteSavePoints`/`remoteGetPoints`
   (user-reachable via `remotePointsPath`), `gofa-mod-edit`, `gofa-setup`.
   Live-verified mechanism already: a raw space throws client-side.
6. **B1** (bug 7) `gofa-points doSave` validates the robtarget before persisting.
7. **B7** `discover()` concurrency cap (fixed pool, ~64 sockets).
8. **D3** async `fs` in `gofa-points` export/import and `gofa-file` download/upload.

### Phase 2 — behavior change (decision-gated)
9. **A1** (bug 5) `gofa-movej` malformed-payload handling + mirror into the admin
   route so the two paths stop disagreeing.

### Phase 3 — test coverage BEFORE refactor
10. **C2** extend admin-route coverage to the remaining nodes. Deliberately ahead of
    Phase 4: these tests are what make the refactor safe to attempt.

### Phase 4 — structural de-duplication (highest regression risk, now protected)
11. **C4** extract the shared ping/version step in `gofa-setup` (cause of bug 2).
12. **C3** finish factoring the subscribe nodes' WS/reconnect lifecycle.
13. **C1** de-duplicate runtime vs. admin paths across `gofa-setup`,
    `gofa-sequencer`, `gofa-rapid-exec`, `gofa-file`, `gofa-connection-status`,
    following the shared-`ACTIONS`-map pattern `gofa-points.js` already uses.

### Phase 5 — hygiene and close-out
14. **D2** investigate `T_GOFA_LED` (read-only RWS; check whether it also drives the
    ASI light and could fight `BackgroundLed.mod`).
15. **D1 / D6a / D6c** apply the chosen `flows/` values; update `CLAUDE.md` to the
    live IP `192.168.20.43`; refresh the `project_robot_current_ip` memory.
16. **D4** branch + commit per the chosen strategy, keeping agy's config-node change
    in its own commit, separate from the bugfix work.
17. Re-run the full suite; re-run the live tests for anything touching a live path.

### Deliberately excluded
Bug 3's escaping and the npm-surface guard (D6b) are done. No RAPID `.mod` changes
are planned — nothing in A–D requires one, so the byte-for-byte drift check between
`rapid/` and `node-red-contrib-abb-gofa/rapid/` stays green by construction.
