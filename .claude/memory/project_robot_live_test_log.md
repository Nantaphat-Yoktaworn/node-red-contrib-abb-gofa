---
name: project-robot-live-test-log
description: "Running log of live RWS/socket tests against the real GoFa controller, with status snapshot and outcome per entry"
metadata: 
  node_type: memory
  type: project
  originSessionId: 58ab807b-429c-4693-a7f1-105ef986edca
---

Dated log of live tests run against the actual robot controller (not simulated), so future sessions know what's already been confirmed/denied and don't repeat the same test blind. Pair with [[feedback-check-robot-status-before-live-test]] (check status before testing) and [[feedback-curl-mastership-needs-shared-cookie-jar]] (testing-methodology gotcha hit during the 2026-07-06 entry below).

**Why this exists:** this project verifies everything live against real hardware before writing code (see the `abb-rws` skill's "verify before building" section) — this log is the durable record of what those live tests actually found, separate from the code/docs that get written as a result.

**How to apply:** before re-testing something already logged here, check this file first — re-test only if the controller's RobotWare version, IP, or firmware has changed since the entry.

---

### 2026-07-06 — RWS `loadmod` action (load/reload RAPID module without FlexPendant)

**Robot state at test time:** IP `192.168.20.36`, RobotWare 7.21.0+229, `ctrlstate: motoron`, `opmode: AUTO`, `ctrlexecstate: stopped`.

**Goal:** confirm whether `POST /rw/rapid/tasks/{task}/loadmod` (the RWS action to load/reload a RAPID module without touching the FlexPendant, referenced in ABB's general RWS docs as `?action=loadmod`) works on this controller/firmware, as a candidate to close the gap where `gofa-upload-mod` only uploads file bytes and still requires a manual FlexPendant "Load Module" step.

**Findings:**
- Query-action form `POST /rw/rapid/tasks/T_ROB1?action=loadmod` -> `405 Method Not Allowed` (`rws_resource.cpp: HTTP method not supported by resource`) — same OmniCore query-action rejection pattern seen elsewhere in this project (execution, symbols).
- Path-based form `POST /rw/rapid/tasks/T_ROB1/loadmod` (body `modulepath=$HOME/Programs/MainModule.mod&replace=true`) — resource exists and is recognized, but requires `Accept: application/hal+json;v=2.0` (NOT the `application/xhtml+xml;v=2.0` used by every other endpoint in this project) — with the xhtml Accept header it errors "Server cannot generate response for given accept header."
- With the correct JSON Accept header: returns a real, meaningful error — `icode:-4501`, "User does not have required mastership" — confirming the endpoint IS real and functional, gated on edit mastership (same domain/error code as `resetpp`).
- First mastership attempt hit a methodology bug: testing acquire-then-call-then-release as three independent bare-auth curl calls (no shared cookie jar) orphaned edit mastership for ~5 minutes — see [[feedback-curl-mastership-needs-shared-cookie-jar]]. Cleared on its own via the RWS inactivity timeout; no forced/manual release was found or needed.
- **Retest with one shared cookie session (request -> loadmod -> release, all same session): full success.** `POST /rw/mastership/edit/request` -> `204`. `POST /rw/rapid/tasks/T_ROB1/loadmod` (body `modulepath=$HOME/Programs/MainModule.mod&replace=true`, `Accept: application/hal+json;v=2.0`) -> `200` with body `{"_type":"rap-task-module-li","_title":"loaded-module","name":"MainModule"}`. `POST /rw/mastership/edit/release` -> `204`, verified via `GET /rw/mastership/edit` -> `"mastership":"nomaster"`.
- **`activate` action also confirmed working**, same pattern: request mastership (`204`) -> `POST /rw/rapid/tasks/T_ROB1/activate` with body `module=MainModule` -> `204` -> release mastership (`204`).
- Post-test health check: `GET /rw/rapid/execution` still `ctrlexecstate: stopped` — robot ended in the identical state it started in (`motoron`/`AUTO`/`stopped`), no side effects, nothing left running or locked.

**Status: CONFIRMED WORKING on this controller (RobotWare 7.21.0+229).** `loadmod` + `activate` via RWS, gated on edit mastership (same domain as `resetpp`), is a real, functional path to load/reload/activate a RAPID module entirely from RWS — no FlexPendant "Load Module" step required. This closes the gap noted in `gofa-upload-mod` (which today only uploads file bytes and still requires manual FlexPendant reload per the README). Not yet built into a node — this was a live endpoint confirmation only. Two things still needed before wiring it into `gofa-upload-mod`: (1) confirm the required `Accept: application/hal+json;v=2.0` header and JSON response parsing (this project's `rwsGet`/`rwsPost`/`parseXhtml` helpers assume XHTML everywhere else — this endpoint is the first exception found), (2) test `loadmod` with an actually-changed module (this test only reloaded the identical file with `replace=true`, so a real content change + reload was not exercised).

---

### 2026-07-06 (follow-up session) — `loadmod` wired into `gofa-rapid-exec`, re-verified live

A later session (different `originSessionId`, no memory of the entry above at start) independently re-derived this from scratch: first curl-tested only the documented query-action form (`?action=loadmod`), got `405` on three resources/name variants, and nearly wrote "confirmed impossible" into `CLAUDE.md`/`abb-rws` skill before re-reading this memory file and finding the path-based form already logged above. Re-tested live to confirm the earlier entry still holds (robot state: `192.168.20.36`, RobotWare 7.21.0+229, `motoron`/`AUTO`/`stopped`):

- Path-based `POST /rw/rapid/tasks/T_ROB1/loadmod` with `Accept: application/hal+json;v=2.0`, body `modulepath=$HOME/Programs/MainModule.mod&replace=true`, mastership-gated → reproduced exactly: `200`, `{"state":[{"name":"MainModule"}]}`.
- `POST /rw/rapid/tasks/T_ROB1/activate` (body `module=MainModule`) → reproduced: `204`.
- Both released mastership cleanly, no side effects (`ctrlexecstate` stayed `stopped` throughout).

Then built and verified `loadmod` as a new `gofa-rapid-exec` action (not `activate` — out of scope for that session's ask): `gofa-robot.js` got a `rwsPostHal()` helper (the `_request()` accept header was hardcoded to xhtml before this; now takes an optional param) and `gofa-rapid-exec.js` got a `loadmod` branch using `withMastership()` + `rwsPostHal()`, plus `task`/`modulePath`/`replace` config fields and msg.payload overrides. **Verified by exercising the actual node code (not curl)** — a throwaway Node.js harness stubbed `RED.nodes.createNode/getNode/registerType` + `RED.httpAdmin`/`RED.auth`, loaded the real `gofa-robot.js`/`gofa-rapid-exec.js` modules, and fired a real `input` event with `action: 'loadmod'` against the live robot: returned `{"ok":true,"action":"loadmod","task":"T_ROB1","modulePath":"$HOME/Programs/MainModule.mod","module":"MainModule"}`. Post-test check confirmed no side effects.

**Takeaway for future sessions:** always check this log file in full (not just skim the header) before curl-testing something that sounds already-covered — the first 405 result here almost produced a false "confirmed impossible" doc entry that would have contradicted an already-verified working endpoint just because a different (wrong) request shape was tried first.

---

### 2026-07-06 (fourth session) — pose (robtarget) is not subscribable over RWS

Investigated converting `gofa-subscribe-pose` from 500ms polling to WS push, since the same subscription mechanism had just been proven solid for `gofa-subscribe-io`/`gofa-subscribe-state`. Robot state throughout: `192.168.20.36`, RobotWare 7.21.0+229, `motoron`/`AUTO`/`running` (RAPID running at 25% speed override).

- `OPTIONS /rw/motionsystem/mechunits/ROB_1/robtarget` → `Allow: GET,OPTIONS`, no `sub-subscribe` form in the body (IO signals and tasks both have one).
- `POST /subscription` naming that resource with 7 suffix guesses (`;robtarget`, `;state`, `;value`, `;position`, `;cartesian`, `;ms-robtargets`, none) → **all 7 timed out** (8s then 5s timeouts, server never responded) — a materially different failure than the fast `400` a wrong-but-plausible IO suffix got earlier this project. Confirmed the subscription mechanism itself was still healthy in the same run: a parallel subscribe to `/rw/panel/ctrl-state;ctrlstate` succeeded instantly (`201`, got a `wss://` location).
- `OPTIONS /rw/motionsystem/mechunits/ROB_1` (one level up) *does* have a subscribe form — but for `/rw/motionsystem/mechunits;mechunitmodechangecount` (a mode-change counter, not position). `/rw/motionsystem/mechunits/ROB_1/jointtarget` and `/rw/motionsystem` root: both `Allow: GET,OPTIONS`, no subscribe form.
- Leftover artifact: the ctrl-state sanity-check subscription (`poll/38`) was created with a throwaway session and couldn't be deleted from a different session (`400`, same session-scoping behavior as the mastership orphan case) — left to clear via RWS's own inactivity timeout, no robot impact (confirmed `check-status.js` clean before and after).

**Status: CONFIRMED — continuous position telemetry is not exposed through RWS's subscription/event system on this controller.** That system covers discrete state-change events only (IO transitions, task state, mechunit mode) — ABB's mechanism for continuous motion streaming is a separate protocol (EGM, UDP-based), not RWS. `gofa-subscribe-pose` stays on polling; this is a real capability gap in RWS, not a missing parameter or a bug on our side. Full writeup: `abb-rws` skill, Motion System section.

---

### 2026-07-06 (fifth session) — activate wired into gofa-rapid-exec; loadmod/activate require RAPID stopped

Wired the already-confirmed `activate` action (`POST /rw/rapid/tasks/{task}/activate`, body `module=<name>`) into `gofa-rapid-exec` as a fourth action alongside `start`/`stop`/`resetpp`/`loadmod`, same mastership + hal+json pattern as `loadmod`. Mocked tests added (97 total passing).

**Live test hit a real 403 that revealed an important operational constraint.** First live run (robot state: `192.168.20.36`, RobotWare 7.21.0+229, `motoron`/`AUTO`/**running**) failed: `HTTP 403`. Digging into the full response body (the code was discarding it) showed `rws_resource_rapid_task.cpp[1860]: Operation not allowed for current PGM state (Started/Stopped/Ready) code:-1073442809`. Tested both directions to confirm the cause, with the user's permission to stop RAPID for the test:
- Stopped RAPID (`gofa-rapid-exec` `stop` equivalent, `204`) → `activate` on `T_ROB1`/`MainModule` → `204` success.
- Confirmed `loadmod` has the identical restriction: same call, RAPID running → `403` with the same `PGM state` message.
- Restored original state afterward: `resetpp` (`204`) → `start` (`204`) → confirmed `ctrlexecstate: running` again, matching the state before testing began.

**Fixed a real gap this exposed**: `gofa-robot.js`'s `request()` discarded the RWS error response body entirely on non-2xx, throwing only `HTTP <code> <path>` — so this exact 403 would have reached a user with zero explanation of why. Now extracts the `msg` field (handles both xhtml `<span class="msg">` and hal+json `"msg":"..."` shapes) and appends it to the thrown error, for every RWS call in the palette, not just these two. `gofa-rapid-exec` also gained a specific hint ("RAPID must be stopped for loadmod/activate — stop it first") when it detects this exact rejection text.

**Status: CONFIRMED — `loadmod` and `activate` both require RAPID to be stopped**, in both directions on the same call (not just inferred from one success case). Documented in `CLAUDE.md`, the `abb-rws` skill, and `gofa-rapid-exec`'s help text. Demo flow (`flows/gofa_demo_flow.json`) got an "Activate Module" row alongside the existing "Load Module" one.

---

### 2026-07-06 (sixth session) — on-robot point storage via RWS fileservice (no MainModule.mod changes)

User asked for saved points ("teach a point") to be storable **on the robot** instead of `points.json` on the Node-RED host — first framed as "save it into the `.mod`". Used plan mode; two design pivots surfaced during exploration, both confirmed with the user via AskUserQuestion before building:

1. **New nodes vs extend existing 5** (`gofa-save-point`/`gofa-go-point`/`gofa-delete-point`/`gofa-point-list`/`gofa-sequencer`) — user chose extend, via a `Storage: Local/On-Robot` toggle + `msg.payload.storage` override, same pattern as every other action-select in this palette.
2. **Where the data actually lives** — first framing (inside RAPID/`MainModule.mod`, new socket commands) was abandoned once the 80-char RAPID `string` cap was checked against a real point record (`name;x;y;z;q1..q4;cf1..cfx` already brushes 80 chars for one point with a short name — see the GOTO-token rounding note already in `CLAUDE.md`). Pivoted to: **a plain JSON file on the robot's own disk, managed entirely over RWS `fileservice` `GET`/`PUT`** (same mechanism `gofa-upload-mod`/`gofa-file-read` already use) — zero RAPID/`MainModule.mod` changes, zero reload needed, completely sidesteps the string limit since it's raw HTTP. User confirmed this pivot too.

**Live-tested the RWS mechanism before writing any node code** (robot: `192.168.20.36`, RobotWare 7.21.0+229, `motoron`/`AUTO`/`running`):
- `GET /fileservice/$HOME/Programs/gofa_points_test.json` on a path that doesn't exist → clean `404` (`rapi_file_service.cpp: Path does not exist`) — safe to treat as `[]`.
- `PUT` with `Content-Type: application/json` → **`415`**, but the error body itself names the two valid options: `text/plain;v=2.0` or `application/octet-stream;v=2.0`. Retried with `text/plain;v=2.0` (already proven for `.mod` uploads) → `201` create / `200` update, confirmed full-overwrite (not append) via round-trip.
- `DELETE` also works (`204`) but needs an `Accept` header — not used in the actual design (always overwrite, never delete-then-recreate).

**Built**: `gofa-robot.js` gained `remoteGetPoints`/`remoteSavePoints`/`remoteAddPoint`/`remoteDeletePoint`/`remoteFindPoint` (mirroring the sync local methods exactly — same auto-naming, same duplicate-name rejection, via a shared `resolvePointName()` helper extracted from `addPoint()`) plus a `remotePointsPath` config field (default `$HOME/Programs/gofa_points.json`) and a `/gofa-robot/:id/remote-points` admin endpoint for the editor's point-picker dropdowns. All 5 nodes got the `storage` field/override; `gofa-sequencer` fetches the whole remote list **once** per run (not once per step).

**Verified live end-to-end** (not just mocked): saved the robot's actual current pose as `livetest_pt1` via `gofa-save-point` (remote), listed it via `gofa-point-list`, moved to it via `gofa-go-point` (real `GOTOJ` dispatched, `OK:GOTO` ack), ran it through `gofa-sequencer` as a one-step sequence, deleted it via `gofa-delete-point`, confirmed the remote file ended up empty. Robot state unchanged before/after each round (`check-status.js`).

**Known, accepted limitation**: no concurrent-write protection on the remote file (unlike local storage's mtime-drift warning) — deliberately not built, documented as acceptable for a human-paced workflow.

Full plan: `C:\Users\RD2\.claude\plans\make-another-action-for-playful-reef.md`.

---

### 2026-07-07 — DSQC1030 I/O nodes tested live; RWS DO-write confirmed dead; SETDO added via socket

RD2 wired a DSQC1030 (Scalable I/O) to the controller (now at `192.168.20.15`, drifted again from the `.36` used in the prior session). Full writeup and exact endpoints in `reference_dsqc1030_scalable_io_addressing`; summary here for the log's own timeline.

**I/O node sweep**: `gofa-io-list`, `gofa-di-read`, `gofa-subscribe-io` all confirmed working live against the new board's signals (`ABB_Scalable_IO_0_DI1..16`/`DO1..16`). `gofa-ai-read`/`gofa-ao-write` have nothing to test — board is digital-only. `gofa-do-write` failed with `405` on every DO.

**Chased the 405 to ground, in order:**
1. Checked `write-access` on the signal → `Rapid|LocalManual` (config `Access` = `Default`). Explained where to fix it in RobotStudio (`Configuration` → `I/O System` → `Signal` → `Access Level`) by reading the live `/rw/cfg/eio/eio_access/instances` config API rather than guessing from training data — found the 4 built-in profiles (`Internal`/`Default`/`ReadOnly`/`All`) and their `Rapid`/`LocalManual`/`LocalAuto`/`RemoteManual`/`RemoteAuto` flags live.
2. RD2 changed `Access` to `All` in RobotStudio and restarted the controller. Verified the change took over `/rw/cfg` (confirmed `Access: All` on DO1 and DO16) and over the plain signal GET (`write-access` now includes `RemoteManual`).
3. **`POST /set` still 405'd.** Tried path-based `/set`, IRC5 `?action=set`, direct `PUT`, and a `hal+json` Accept header (in case this needed the same quirk as `loadmod`) — all identical `405 rws_resource.cpp[472]`.
4. `OPTIONS /rw/iosystem/signals/{name}` → `Allow: GET,OPTIONS` on **every** signal tried, including the pre-existing `Asi1LedRed` — proved this is controller/firmware-wide, not specific to the new board or its access config. This also retroactively corrects the earlier SETLED note in `CLAUDE.md`, which blamed the ASI write failure solely on `Rapid|LocalManual` access — that's true as far as it went, but the deeper cause (no working RWS write path for iosystem signals at all on this firmware) applies equally to any signal.
5. Also ruled out a "needs simulation mode first" theory (`/rw/iosystem/signals/{name}/simulated` → `404`, `405`).

**Fix: added `SETDO:<name>:<value>` to `MainModule.mod`** (`TrySetDo`, dispatched in the existing `TryGetVar`/`TrySetVar`/`TrySetLed` ELSEIF chain), using RAPID's `SetDO` against an explicit 16-way allow-list of `ABB_Scalable_IO_0_DO1`..`DO16` (RAPID can't resolve an arbitrary runtime string to a signal reference, same reason `TryGetVar`/`TrySetVar` are allow-lists too).

**Full live deploy-and-test cycle, hit one real snag**: uploaded the patched module (`gofa-upload-mod`'s own `patchServerIp` logic, standalone) → `loadmod` first failed `403`, edit mastership held by "FlexPendant device" (`mastershipheldbyme: FALSE` on `GET /rw/mastership/edit`) — traced to the RobotStudio config-editor session from the `Access` change earlier in this same session; RD2 cleared it from the FlexPendant and the retry succeeded. Then `resetpp` → motors were off (`motoroff`) after the restart, turned on via `POST /rw/panel/ctrl-state` → mode was `AUTO` (already cleared from `guardstop`/`MANR` by RD2's earlier restart-recovery steps) → `start` succeeded, `ctrlexecstate: running`, socket alive.

**`SETDO` verified end-to-end**: socket `SETDO:ABB_SCALABLE_IO_0_DO1:1` → `OK:SETDO`, independently confirmed via a live RWS read (`lvalue: 1`); set back to `0`, re-verified `0`. Also tested `DO16` (last index in the allow-list), an unknown signal name (`ERR:UNKNOWN_SIGNAL`), and bad values `5` and `abc` (`ERR:PARSE` both). Robot ended healthy: `motoron`/`AUTO`/`running`, socket `ok`.

**Not yet done**: `gofa-do-write` node itself still calls the dead RWS path — needs a socket-based rewrite or a new node before this is usable from a Node-RED flow, not just raw socket commands. `Access` was left at `All` on the DSQC1030 signals (RD2's call — didn't revert since reverting needs yet another restart and `All` alone is harmless, just more permissive than needed).

---

### 2026-07-07 (follow-up, same day) — corrected: RWS CAN write I/O, wrong action name all along (`/set-value`, not `/set`)

Immediately after the SETDO entry above, RD2 asked "did you search only yet? for more info" — pushback on treating 6 live `405`s as proof RWS I/O write was categorically dead, without checking ABB's own current docs/forums first (the `abb-rws` skill's own rule, not followed until asked).

`WebSearch` + `WebFetch` against ABB's tech-community forum ("How can I set an IO signal with RWS2 on an Omnicore controller?") surfaced the real action name: **`POST /rw/iosystem/signals/{name}/set-value`** — not `/set` (the path this project had used in `gofa-do-write.js`/`gofa-ao-write.js`/the `abb-rws` skill for a long time, silently broken the whole time on this controller, not just after the DSQC1030 was added).

**Confirmed live immediately** (robot state: `192.168.20.15`, `motoron`/`AUTO`/`running`):
- `POST /rw/iosystem/signals/ABB_Scalable_IO_0_DO5/set-value` (`Access: All` at the time) with `lvalue=1` → `204`, read back `lvalue: 1`; set back to `0`, re-verified.
- Identical call against `ABB_Scalable_IO_0_DO1` (`Access: Default`, RD2 had reverted it earlier in this session) → `403` — genuine access-denied behavior, contrasted against the earlier `405`s which meant "wrong URL" not "access denied."
- `Asi1LedGreen` (pre-existing signal, `Access: Default`, never touched) → `403` via `/set-value` too — same correct-access-check behavior, confirming the original SETLED-note claim ("RWS cannot write ASI signals") was *directionally* right under current config but for the wrong underlying reason, and is not a permanent limitation — changing `Access` to `All` would let RWS write it directly, no socket route needed.

**Fixed `gofa-do-write.js`/`gofa-ao-write.js`** to call `/set-value` instead of `/set` (one-line change, both files). **Re-verified by exercising the real node code**, not just curl: built a minimal `RED` stub (`createNode`/`getNode`/`registerType`), loaded the actual `gofa-do-write.js` module, fired a real `input` event against `ABB_Scalable_IO_0_DO5` — got `{ok:true, signal:'ABB_Scalable_IO_0_DO5', value:1}`, independently confirmed via a live RWS read, then reset to `0`.

**Docs corrected**: the `abb-rws` skill's I/O Service section (was documenting `/set` as fact, now documents `/set-value` with the full correction story), `CLAUDE.md`'s SETLED and SETDO notes (both rewritten — SETDO is kept as a real, working alternative for signals that shouldn't get `Access: All`, not the only option), and the `dsqc1030-scalable-io-addressing` memory.

**Takeaway, stated plainly for next time**: getting the same error from several different-looking request variants (path-based, query-action, PUT, alternate Accept header) is *not* the same as ruling out a wrong-but-plausible resource name entirely — all those variants shared the same wrong noun (`set`). The fix was a 2-minute web search, done only after the user pushed back on the "confirmed impossible" framing. Check current vendor community content before writing a permanent-limitation claim into project docs, especially when every failure mode looks identical (same error code, same message) across "different" attempts — that pattern itself is a hint the attempts aren't as different as they look.

---

### 2026-07-06 (third session) — built `mastership-test.js` / `/mastership-test` skill

Same day, yet another session (user asked "is there another process a tool like `/robot-status` would help?" after praising `check-status.js`). Identified the mastership request/action/release dance as the recurring pain point — this project has now hit it twice (the orphaned-lock bug above, and a `406` from a bare curl POST missing `Content-Type` on an empty body). Built `node-red-contrib-abb-gofa/mastership-test.js` (CLI: `MSYS_NO_PATHCONV=1 node mastership-test.js <path> [body] [--hal]`) wrapping `createRobotClient()`'s existing `withMastership()`, plus a `/mastership-test` skill command mirroring `/robot-status`.

Verified live (robot state: `motoron`/`AUTO`/`stopped`, unchanged before/after):
- `node mastership-test.js /rw/rapid/execution/resetpp` → `OK` (mastership request → resetpp → release all succeeded in one call)
- `node mastership-test.js /rw/rapid/tasks/T_ROB1/loadmod 'modulepath=$HOME/Programs/MainModule.mod&replace=true' --hal` → `OK`, same JSON body as the raw-curl test above (`{"state":[{"name":"MainModule"}]}`)

Also hit and documented a Git-Bash-specific gotcha while testing this tool itself: a bare leading `/rw/...` argument gets silently rewritten by MSYS into a Windows path (`C:/Program Files/Git/rw/...`) before Node ever sees it, producing a confusing "Request path contains unescaped characters" error with no hint that the shell mangled the arg. Fixed by requiring `MSYS_NO_PATHCONV=1` — documented in the script's own usage banner, the `/mastership-test` skill, and `CLAUDE.md` so it isn't rediscovered blind next time.
