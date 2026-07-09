# ABB GoFa 12 (CRB 15000-12/1.27) — Claude Code Context

Custom Node-RED palette (`node-red-contrib-abb-gofa`) for controlling an ABB GoFa 12 (CRB 15000-12/1.27) collaborative robot over a local network. No extra ABB licenses required.

## Skills available

- `/abb-rws` — full RWS API reference (endpoints, auth, response parsing)
- `/omnicore-c30` — OmniCore C30 controller specs
- `/crb15000` — GoFa arm specs, joint limits, working range
- `/robot-status` — runs `check-status.js` (below) against the live controller and reports Motors/Mode/RAPID/Speed/Socket; use before any live RWS/socket test, not just when explicitly asked
- `/mastership-test` — runs `mastership-test.js` (below) to live-test any mastership-gated RWS endpoint (`resetpp`, `loadmod`, `activate`, RAPID var writes, or a newly-discovered one); use instead of hand-rolled `curl` any time a task is "try/verify a mastership-gated RWS action live"

## Standalone status-check script

`node-red-contrib-abb-gofa/check-status.js` — plain Node.js, no Node-RED runtime needed. Run directly (`node check-status.js`) to preflight-check the robot before a live test: Motors/Mode/RAPID/Speed via RWS, plus a socket `PING` (the motion socket server only runs while RAPID is actually executing, so `RAPID: stopped` reliably means the socket ping will fail too — that's expected, not a bug). Flags: `--full` (adds RobotWare version, controller identity, `T_ROB1` task state, last 3 error/warning elog entries), `--json`. Connection defaults match this doc's table below except IP, which is `192.168.20.36` (drifted from the `.33` default — see the `SERVER_IP` note); override any of it per-invocation via `GOFA_IP`/`GOFA_RWS_PORT`/`GOFA_SOCKET_PORT`/`GOFA_USERNAME`/`GOFA_PASSWORD` env vars. Exit codes: `0` OK, `1` RWS unreachable, `2` RWS OK but socket unreachable. Built on `createRobotClient()`, a RED-independent factory extracted from `gofa-robot.js`'s session/auth/cookie logic (`GoFaRobotNode` now just delegates to it) — the same "export pure helpers for standalone use" pattern `test.js` already relies on for `parseXhtml`/`gotoToken`/etc.

## Standalone mastership-test script

`node-red-contrib-abb-gofa/mastership-test.js` — plain Node.js, no Node-RED runtime needed. Wraps an arbitrary RWS POST in `createRobotClient()`'s `withMastership()` (acquire edit mastership → call → release, always, one shared session) so ad-hoc live tests of a mastership-gated endpoint can't repeat two mistakes already hit in this project: forgetting `Content-Type` on the empty-body mastership request/release POSTs, and orphaning the lock by testing request/action/release as separate bare-auth `curl` calls with no shared cookie jar (see the `feedback-curl-mastership-needs-shared-cookie-jar` memory). Usage: `MSYS_NO_PATHCONV=1 node mastership-test.js <path> [body] [--hal]` — `MSYS_NO_PATHCONV=1` is required in Git Bash, or the leading `/` in `<path>` gets rewritten into a Windows path before Node sees it; `--hal` sends `Accept: application/hal+json;v=2.0` (needed for `loadmod`/`activate`, see below). Same env var overrides as `check-status.js`. Prefer this over hand-rolled `curl` for any mastership-gated test, per the `/mastership-test` skill above.

## Architecture — two communication layers

**TCP Socket (port 1025)** — motion commands. The RAPID program (`rapid/MainModule.mod`) runs a socket server on the controller. Each Node-RED node opens a fresh TCP connection, sends one newline-terminated command, reads one `OK:<CMD>` or `ERR:<CMD>` reply, and closes.

**RWS HTTPS (port 443)** — telemetry and motor control. REST API built into OmniCore. Auth is Basic on first request → cookie thereafter (auto-refresh on 401). All RWS calls go through `rwsGet()`/`rwsPost()` helpers in `gofa-robot.js`. Responses are XHTML; values extracted with `parseXhtml(body, className)`.

Rule: **motion always goes through the socket; read-only data and motor control go through RWS.**

## RAPID socket protocol

| Command | What it does |
|---------|-------------|
| `HOME` | Move to home position |
| `SETHOME` | Capture current pose as home, persist to `HOME:/Programs/gofa_home.cfg` |
| `GOTOJx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveJ (joint-interpolated, 11 `;`-separated numbers) |
| `GOTOLx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveL (straight-line TCP path) |
| `X+20` / `Y-10` / `Z+5` | Translate TCP ±mm in base frame (max 50 mm) |
| `RX+5` / `RY-10` / `RZ+15` | Rotate TCP ±° in tool frame (max 30°) |
| `J1+10` / `J3-5` | Jog single joint ±° (max 30°, joints 1–6) |
| `SPEED50` | Set speed override 1–100% |
| `MOVEJ<j1;j2;j3;j4;j5;j6>` | Absolute joint move in degrees |
| `ZONE<name>` | Set path blend zone (FINE / Z1 / Z5 / Z10 / Z20 / Z50 / Z100) |
| `STOP` | Halt motion immediately |
| `PING` | Connectivity test |
| `GRIPON` / `GRIPOFF` | Stub only (no I/O behind it) — kept for manual/raw-socket testing; `gofa-grip` itself now uses RWS `/set-value` instead, same as `gofa-do-write` |
| `GETVAR:<name>` | Read a PERS variable; replies `VAL:<value>` or `ERR:UNKNOWN_VAR` |
| `SETVAR:<name>:<value>` | Write a PERS variable; replies `OK:SETVAR`, `ERR:UNKNOWN_VAR`, or `ERR:PARSE` |
| `SETLED:<r>;<g>;<b>;<period>` | Set ASI status light color (0–255 each) and hardware blink period; replies `OK:SETLED` |
| `RESETLED` | Restore ASI LED to default RAPID-running state (solid green); replies `OK:RESETLED` |
| `SETDO:<name>:<value>` | Set a digital output by RWS signal name (0/1); replies `OK:SETDO`, `ERR:UNKNOWN_SIGNAL`, or `ERR:PARSE` |
| `EGMJOINT` | **`MainModuleEGM.mod` only** — ack `OK:EGMJOINT`, then this task stops serving TCP and blocks in an EGM joint-streaming session until the `gofa-egm` node's UDP session goes quiet, at which point TCP serving resumes. On plain `MainModule.mod` this command doesn't exist and falls through to `ERR:EGMJOINT` like any other unrecognized command — see the EGM section below. |

Ack is sent **before** the motion starts. RAPID error handler (StopMove/ClearPath/StartMove) keeps the server alive on motion faults.

**GETVAR/SETVAR note**: variable names are uppercased by CleanCmd in RAPID (`nTestVar` → matched as `NTESTVAR`). String values are extracted from `rawclean` (preserves original case/spaces). To expose a new PERS variable, add an `ELSEIF` block in both `TryGetVar` and `TrySetVar` in `MainModule.mod`. Built-in: `nTestVar` (num), `sTestMsg` (string).

**SETLED/RESETLED note**: `SetGO`-controlled ASI signals still go through the RAPID socket server, not RWS — `TrySetLed` in `MainModule.mod` handles `SETLED` via `SetGO` on `Asi1LedRed`, `Asi1LedGreen`, `Asi1LedBlue`, `Asi1LedPeriod`. Software-controlled counted blink (Node-RED side) is handled by `gofa-asi-led` when `blinkCount > 0`; in that case `period` is ignored and set to 0. (Historical note: this used to say "HTTP RWS cannot write them" — corrected below. RWS *can* write them, same as any other signal, once `Access` is `All`; the ASI signals are just left at `Default` today, and `SETLED` predates the `/set-value` discovery, so it hasn't been switched over.)

**RWS I/O write note — `/set-value` is the real action, not `/set`.** `gofa-do-write`/`gofa-ao-write` used `POST /rw/iosystem/signals/{name}/set` for a long time; that path is simply wrong on this OmniCore controller (`OPTIONS` on it is `404`; POSTing it is `405 rws_resource.cpp[472]: HTTP method not supported by resource`, on *every* signal, not just restricted ones). That `405` was misread as "RWS can't write I/O on this firmware at all" — a real DSQC1030 test session got 6 variants of `405` in a row (path-based `/set`, IRC5 `?action=set`, direct `PUT`, `hal+json` Accept, a `/simulated` sub-resource guess) and concluded RWS write was dead, leading to the `SETDO` socket command below as a workaround. **That conclusion was wrong.** The real action, found via ABB's own community forum, is **`POST /rw/iosystem/signals/{name}/set-value`** (body `lvalue=<value>`) — confirmed live: `204` success on a signal with `Access: All`, `403` (correctly) on one still at `Access: Default`. `gofa-do-write.js`/`gofa-ao-write.js` are now fixed to call `/set-value`; re-verified by exercising the real node code (not just curl) against `ABB_Scalable_IO_0_DO5`. **Access level still needs to be `All`** (via RobotStudio `Controller` → `Configuration` → `I/O System` → `Signal` → `Access Level`, needs a controller restart) for RWS write to work on a given signal — that part of the original diagnosis was always correct, only the endpoint name was wrong.

**SETDO note (kept as a working alternative, no longer the only option)**: `TrySetDo` in `MainModule.mod` adds a `SETDO:<name>:<value>` socket command using RAPID's `SetDO` against an explicit per-signal allow-list (`ABB_Scalable_IO_0_DO1`..`DO16` — same pattern as `TryGetVar`/`TrySetVar`, since RAPID can't resolve an arbitrary runtime string into a signal reference). Confirmed live end-to-end: socket `SETDO:ABB_SCALABLE_IO_0_DO1:1` → `OK:SETDO`, independently verified via an RWS read showing `lvalue: 1`; set back to `0`, re-verified; also confirmed unaffected by the signal's RWS `Access` level (works identically on `Default` and `All`, since RAPID itself always has `Rapid` access). Unknown signal name → `ERR:UNKNOWN_SIGNAL`; bad value → `ERR:PARSE`. Useful when you don't want to open a signal's `Access` to `All` (which permits any RWS client to write it) but still want Node-RED control — otherwise, `gofa-do-write` via `/set-value` is simpler (no `MainModule.mod` reload, no RAPID-running requirement).

**Analog nodes removed (2026-07-07)**: `gofa-ai-read`/`gofa-ao-write` were deleted — confirmed live that this controller has zero `AI`/`AO` signals anywhere (only `DI`/`DO`/`GO` exist; the DSQC1030 is digital-only, and the C30 has no native analog port). Analog I/O would need ABB's `DSQC1032` Analog Add-On module, which attaches to the existing DSQC1030 digital base device rather than replacing it (see the `dsqc1030-scalable-io-addressing` memory). Re-add these nodes (same `/set-value`/plain-GET pattern as `gofa-do-write`/`gofa-di-read`) if that module is ever installed.

**SERVER_IP note**: `MainModule.mod` binds its socket server with `CONST string SERVER_IP := "..."`, which RAPID's `SocketBind` requires to be a real configured interface address (no wildcard bind). If this drifts from the controller's actual IP, `SocketBind` silently fails and every socket command times out with no error on the controller side. `gofa-upload-mod` mitigates this by always rewriting `SERVER_IP` to the `gofa-robot` config node's IP on every upload (`patchServerIp` no-ops on any file that doesn't contain the constant, so this is safe for uploading other files too); the constant in the repo copy is just the fallback for a first upload or manual FlexPendant/SD-card load.

**Module reload (`loadmod`) note**: reloading a module file already on disk into a running task (the FlexPendant's **Load Module** step) *is* possible over RWS, but not via the documented RWS 1.0/IRC5 query-action form — `POST /rw/rapid/tasks/{task}?action=loadmod` is `405` on this controller (same red-herring `Allow: GET,POST,OPTIONS` header as the `/rw/rapid/symbols` case below; that resource's real POST use is `/subscription`). The working call is **path-based**: `POST /rw/rapid/tasks/{task}/loadmod`, body `modulepath=<path>&replace=true`, and — the one exception in this whole palette — it requires `Accept: application/hal+json;v=2.0`, not the `xhtml+xml` every other endpoint uses (xhtml Accept errors on this resource). Gated on edit mastership, same as `resetpp`. Confirmed live against `T_ROB1`/`MainModule` (RobotWare 7.21.0+229): `200` with JSON body `{"state":[{"name":"MainModule", ...}]}`, no side effects. `gofa-rapid-exec`'s `loadmod` action wraps this (`rwsPostHal` in `gofa-robot.js` sends the hal+json Accept header). A companion `activate` action (`POST /rw/rapid/tasks/{task}/activate`, body `module=<name>`) works the same way and is now also wired into `gofa-rapid-exec`, as does `unloadmod` (`POST /rw/rapid/tasks/{task}/unloadmod`, body `module=<name>` — same hal+json/mastership requirements; removes the named module from the task only, the file stays on the controller's disk). `unloadmod` was needed once it was confirmed live that `loadmod`'s `replace` only replaces a *same-named* module — loading `MainModuleEGM` while `MainModule` is still loaded leaves both loaded, both declaring `PROC main()`, and RAPID rejects `resetpp`/`start` with `(87,5): Global routine name main ambiguous` (see the EGM section below). **All three require RAPID to be stopped** — confirmed live in both directions: succeeds (`204`) with `ctrlexecstate: stopped`, fails `403` (`rws_resource_rapid_task.cpp: Operation not allowed for current PGM state`) with `ctrlexecstate: running`, on the identical call. `gofa-rapid-exec` surfaces the RWS error's own reason text (previously discarded — `gofa-robot.js`'s `request()` only threw `HTTP <code> <path>` with no body detail) and adds a specific hint for this rejection. Full test log: see the `abb-rws` skill and the `project_robot_live_test_log` memory.

**GOTOJ/GOTOL note**: bare `GOTO<11 nums>` (no `J`/`L` letter) is still accepted by `TryGoTo` as an alias for `GOTOJ`, for backward compatibility. `gofa-go-point` and `gofa-sequencer` always send the explicit `J`/`L` form based on their "Move type" dropdown. `MoveJ` (joint-interpolated) is the more predictable/reliable choice — RAPID has freedom in how each axis gets there, so it won't fault or slow drastically near a singularity — and is therefore the default at every fallback point: `gotoToken(t, moveType)` in `gofa-robot.js` maps anything other than exactly `'L'` to `'J'`, and both nodes' config defaults are `'J'`. `MoveL` follows a straight line to the target and can hit singularities or joint limits along that line that `MoveJ` would route around, so it's opt-in, not a safer default.

**RAPID start note**: `POST /rw/rapid/execution/start` returns HTTP 200 even when the controller immediately rejects the start (e.g. RAPID error 20055, "program must start in Motor On state") — the rejection isn't surfaced as an HTTP error, so a naive implementation reports `{ ok: true }` for a start that never ran. `gofa-rapid-exec` guards against this for the `start` action only: it reads `/rw/panel/ctrl-state` first and fails fast if motors aren't on, then polls `/rw/rapid/execution` (`ctrlexecstate`) for up to 1.5s after the POST to confirm it actually reached `running`. `stop`/`resetpp` don't have this silent-rejection failure mode and aren't checked.

**RAPID symbol data note**: RWS's generic `/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}` (the RWS 1.0 / IRC5-era documented endpoint for reading/writing any RAPID variable without touching RAPID code) returns `404 SYS_CTRL_E_UNRESOLVED_URL` on this controller. **Not a licensing issue** — verified against ABB's OmniCore C-line product manual (3HAC065034-001) that RWS is a standard, base-included feature, and that the OmniCore option in this area, RobotStudio Connect [3119-1], is unrelated (it's about the RobotStudio desktop app connecting over WAN). The real cause: `GET /rw/rapid` on this controller advertises `symbols` (plural), a search-based resource, not the flat singular `symbol` path from the general RWS docs — the same RWS 1.0-vs-2.0 shape split already seen for `execution` and `iosystem`. **Confirmed impossible, not just unresolved** — a later session fetched ABB's own current Developer Center pages for the exact official `search-symbols` call (method, path, query, form body) and reproduced it verbatim against the live controller (RobotWare 7.21.0+229): `POST /rw/rapid/symbols?action=search-symbols` with ABB's own documented body still returns `405 Method Not Allowed`, despite the response's own `Allow: GET,POST,OPTIONS` header claiming POST is valid; every path/method variant tried (singular action name, path-based action, GET-with-query, module-scoped `symbol` browser) is `404`/`405` or silently empty. This is ABB's own documented syntax failing on live, current firmware — not a guess this time. Full investigation, what was tried, and what's confirmed: see the `abb-rws` and `omnicore-c30` skills. This is why variable read/write goes through the custom TCP `GETVAR:`/`SETVAR:` protocol (allow-listed per variable in `TryGetVar`/`TrySetVar`) — proven and simple, not a workaround for a missing option. `gofa-subscribe-var`'s `readVar()` used to try the dead RWS symbol path before falling back to module-text on every poll; that guaranteed-fail round trip was removed once the endpoint was confirmed permanently broken on this hardware (not just occasionally), so it now goes straight to module-text and always reports `source: 'module-text'`.

**IO subscription note**: `gofa-subscribe-io`'s WebSocket subscribe request used resource suffix `;lvalue` (matching the attribute name a plain GET returns), but OmniCore's subscription service doesn't work that way — each RWS resource has its own fixed subscribable-resource keyword (`gofa-subscribe-state` already had this right, using `;ctrlstate` for `/rw/panel/ctrl-state`), and for I/O signals that keyword is the literal `;state`, not the value's own class name. `;lvalue` always got `400 Invalid resource URI` — confirmed live on both a top-level signal (`GOFA_MotorsOn`) and a device-scoped one (`Asi1Button2`), same path, only the suffix differed between 400 and 201. The `.catch` on that 400 fell through to 500 ms polling with no warning, so **every** signal was silently polling, not just ones that "lack WS support" (that was never a real distinction — no signal in this controller's IO list is WS-incapable; the request was just malformed). Fixed by changing the suffix to `;state`; re-verified by loading the actual patched node file and pressing `Asi1Button2` live — it connected as a real WS ("connected" status, not "polling") and pushed `source:'ws'` events with no poll delay on press and release. Practical implication: `gofa-subscribe-io` can now reliably catch fast events (e.g. a physical button tap) that a 500 ms poll could miss — worth revisiting anywhere the palette currently polls I/O as a workaround for "flaky WS," since that flakiness was this bug, not the hardware.

**ASI buttons note**: the two physical buttons near the GoFa's tool flange are exposed as plain `DI` signals `Asi1Button1` / `Asi1Button2` (`GET /rw/iosystem/signals/Asi1Button{1,2}`, same `lvalue` shape as any other digital input) — readable today with `gofa-di-read` (just set Signal to the name) and subscribable with `gofa-subscribe-io`, no new node needed. This holds **even when the FlexPendant's Wizard menu has a button assigned to a function like "Add a move position"**: confirmed live that a press still produces a real `0→1→0` edge on the RWS signal (both by polling and by WS push) — Wizard reads the same signal rather than claiming it exclusively. Opens the door to a physical "teach" workflow (hand-guide via `gofa-leadthrough-enable`, tap a button, `gofa-subscribe-io` fires a flow that calls `gofa-save-point`) without touching the FlexPendant screen — not built, just confirmed feasible.

**Module-text fallback is confirmed STALE, not just unverified** (`gofa-rapid-var-read`'s fallback and `gofa-subscribe-var`'s only path — reading `/rw/rapid/tasks/{task}/modules/{module}/text` + fileservice, regex-matching `name := value`): tested live by writing a new value to `nTestVar` via socket `SETVAR`, confirming the write with socket `GETVAR` (got the new value), then reading the same variable through this RWS path — it returned the *original* compiled/declared value, not the one just written. This path reflects the module's compiled state, not the variable's live runtime value. Both nodes now mark it `stale: true` with a `warning` field in the payload instead of presenting it with the same confidence as a live socket-`GETVAR` read (`source: 'socket'`, no `stale` field). There is no known live-value alternative for variables outside the `TryGetVar`/`TrySetVar` allow-list until the `/rw/rapid/symbols` search API (see above) is cracked.

**`gofa-rapid-exec` chaining hazard — clear `msg.payload` between two chained instances.** `gofa-rapid-exec` supports overriding its configured `action` via `msg.payload.action` (or a bare `msg.payload` string) — a deliberate, useful feature. But its own success output is `{ok:true, action:<the action it ran>}`, which has exactly that shape. Wiring one `gofa-rapid-exec` node's output straight into another (even through a passthrough `switch` gate, which doesn't alter the message) makes the second node see the first node's `action` as an override and silently repeat it instead of running its own configured action. Caught live in `flows/teach_workflow_flow.json`: `Reset Program Pointer` (action `resetpp`) wired into `Restart RAPID` (action `start`) via a `switch` gate — `Restart RAPID`'s own debug output showed `{ok:true, action:"resetpp"}`, and RAPID never actually restarted (confirmed via `gofa-status`: `rapid` stayed `stopped`). Fixed by inserting a `change` node that resets `msg.payload` to `{}` between them. This only bites when two `gofa-rapid-exec` nodes are chained with nothing in between that replaces `payload` — a `gofa-status` node in between is safe, since it always overwrites `payload` regardless of what it received.

## EGM (Externally Guided Motion) — optional second RAPID module

**Two RAPID modules, one loaded at a time.** `rapid/MainModule.mod` (the default, everything
above assumes this) has no EGM support. `rapid/MainModuleEGM.mod` is a full clone of it —
same TCP command server, byte-identical logic — plus the `EGMJOINT` command and a mode state
machine. Deliberately a separate file rather than a merge into `MainModule.mod`: an EGM
session (`EGMRunJoint`) blocks the RAPID task for its whole duration, so `MainModuleEGM.mod`
can't serve TCP commands while streaming either way — keeping it separate means the module
every other node in this palette depends on carries zero risk from the EGM code, and reverting
is just reloading `MainModule.mod` (untouched, not a "revert a merge" operation).

**Switching between the two modules requires unloading the current one first — confirmed live,
not optional.** `loadmod`'s `replace=true` only replaces a module with the *same name*
(confirmed live: RWS docs and behavior agree). `MainModule` and `MainModuleEGM` are different
module names, so loading one while the other is still loaded does **not** replace it — both
stay loaded, both declare `PROC main()`, and RAPID rejects `resetpp`/`start` with `HTTP 400`
and RAPID error `(87,5): Global routine name main ambiguous`. The fix, also confirmed live: an
explicit `unloadmod` (`POST /rw/rapid/tasks/{task}/unloadmod`, body `module=<name>`, same
hal+json + mastership requirements as `loadmod`) removes the *other* module from the task
first — it only detaches it from the running task, the `.mod` file itself is untouched on the
controller's disk, so nothing is lost. Full swap sequence either direction: `stop` →
`unloadmod` (the module currently loaded) → upload the new file → `loadmod` (`replace=true`)
→ `resetpp` → `start`. (This ambiguity also bit the very first live test of this feature: the
controller had `EGMJointModule` — the sibling `gofa-egm-python` project's own module, left
loaded from earlier standalone testing — sitting alongside a freshly-loaded `MainModule`, same
error, same fix.)

**Mode switch — `gofa-egm`'s `start` action sends `EGMJOINT`** over the TCP socket (ack
`OK:EGMJOINT`), which sets a flag that `ServeClient`/`ServeForever` check right after
`Dispatch` returns — they close the client and server sockets and return, `main()` sees the
flag and runs `RunEgmJoint` (transplanted from `gofa-egm-python/rapid/EGMJointModule.mod`:
`EGMSetupUC ... "EGM_PC" \Joint \CommTimeout:=5` → `EGMActJoint` with the
`egm_minmax1 := [-10.0, 10.0]` hard clamp → `EGMRunJoint ... \CondTime:=300`). While in EGM
mode the closed server socket makes every other socket-based node fail fast with "connection
refused" instead of hanging.

**Mode exit is NOT self-healing — corrected after a live test, 2026-07-09.** The original
design assumed `\CommTimeout` would raise a comm-timeout error once `gofa-egm` stopped
replying, so the ERROR handler would reset and fall back to TCP serving on its own. Confirmed
FALSE live: with a real EGM session connected and streaming, going silent (closing the UDP
socket) left the task blocked inside `EGMRunJoint` for 2+ minutes with no error and no
recovery — whatever `\CommTimeout` actually governs on this firmware, it is not "seconds of
silence before giving up" in any way this can rely on. The mechanism that DOES reliably work,
confirmed live twice: an **external RWS stop** (`POST /rw/rapid/execution/stop`)
hard-interrupts `EGMRunJoint` immediately regardless of EGM state. `gofa-egm`'s `stop` action
(and its `close` handler, when a session is active) now drives this explicitly — `stop` →
`withMastership(resetpp)` → check `ctrl-state` → `start` if motors are on — the same
stop/resetpp/start shape already used elsewhere in this palette (`gofa-rapid-exec`,
`reload_module.js`). A forced stop does **not** run `RunEgmJoint`'s own ERROR handler or
cleanup (it's an external interrupt, not a RAPID error), which is why `bEgmRequested` in
`MainModuleEGM.mod`'s `main()` is cleared **before** calling `RunEgmJoint`, not after — that's
the only reset guaranteed to have already happened by the time the next resetpp+start runs;
clearing it afterward (the original code) left it stuck `TRUE` after a forced stop, so the
very next TCP command would immediately close and kick straight back into another blocking EGM
session instead of being served. `\CommTimeout`/`\CondTime` are kept in `RunEgmJoint` only as
documentation placeholders, not a working backstop — see next.

**Known unresolved cost of the external-stop design: each stop leaks one controller-side EGM
instance, eventually producing RAPID error "Too many EGM instances."** Confirmed live
(2026-07-09): 8 `gofa-egm` start/stop cycles inside 90 seconds was enough to exhaust the
controller's EGM instance pool. Root cause: an external RWS stop skips `RunEgmJoint`'s own
cleanup entirely (see above), including the `EGMReset` that's supposed to release the
controller-side resource — so it doesn't get released, every cycle. **A hypothesis that a
SHORT `\CondTime` (instead of the original `300`) would let `EGMRunJoint` return normally on
its own, avoiding the external kill and the leak, was tested live and disproven**: with
`\CondTime:=6`, a real session was started, confirmed streaming, then the client process was
killed abruptly (simulating a crash, not a clean `stop()`) — 70+ seconds later (11x+
`\CondTime`), `ctrlexecstate` was still `running`, zero recovery. `\CondTime` does not cause a
graceful self-exit on this firmware; do not re-attempt this fix without genuinely new evidence.
**No fix found yet.** The only confirmed recovery once "Too many EGM instances" hits is a full
controller restart (EGM/UC state has zero visibility in RWS — checked `/rw/motionsystem/
mechunits/ROB_1` and `/rw/rapid/tasks/{task}`, nothing there either — so there's no lighter
clear-instances call to make). Practical mitigation until a real fix is found: don't cycle
`gofa-egm` start/stop more than necessary during testing, and expect to restart the controller
periodically during heavy EGM use — plain `resetpp`+`start` recovers RAPID enough to serve TCP
again, but does **not** reclaim the leaked EGM instance pool itself.

**Never resume RAPID with a plain "continue" start after any EGM interruption — always
`resetpp` first.** Confirmed live (2026-07-09): a bare `gofa-rapid-exec` `start` (RWS
`regain=continue`, i.e. "resume from wherever the program pointer is") after an EGM session
had been force-stopped resumed execution *mid-EGM-code* instead of from the top of `main()` —
the program pointer was left sitting near/inside the EGM block from the earlier interrupt, and
resuming there re-entered EGM setup without going through `RunEgmJoint`'s own `EGMReset`
(which only runs when execution starts fresh from `main()`). Result: RAPID error **"You have
to disconnect an EGM instance using EGMReset before you can connect another"**, immediate
`Execution error state`, task stopped again. `gofa-egm.js`'s own `stop()` sequence is immune
to this (it always does `resetpp` before `start`), but this bites if RAPID is restarted through
any *other* path (a plain `gofa-rapid-exec` "start" inject, FlexPendant Play without PP-to-Main,
etc.) after an EGM session — even a normal one, not just a stuck one. **Recovery**: `stop` →
`resetpp` → `start`, same sequence as `gofa-egm.js` itself uses — confirmed live, resolves
cleanly. Rule of thumb: after using `gofa-egm` at all, always `resetpp` before the next
`start`, regardless of which module is loaded or how the EGM session ended.

**If the same error persists even after a genuinely fresh `resetpp`+`start` (confirmed via elog
— "Program started... from the first instruction," not "restarted... from where it was
previously stopped"), the problem has moved from RAPID's program pointer to a stuck
controller-level EGM resource, and only a controller restart clears it — confirmed live
(2026-07-09).** `RunEgmJoint`'s `EGMReset egmID1;` only resets the RAPID-side handle; the `EGM_PC`
UC transport itself is a shared, named controller resource, and if a prior session was killed
mid-negotiation (forced RWS stop while inside `EGMSetupUC`/`EGMActJoint`), the controller can
keep considering that UC "still connected" independent of which RAPID identifier references it
next — no RAPID-level instruction can fix that, since it isn't RAPID's state to reset. Checked
and ruled out first: EGM/UC state is not exposed anywhere in RWS (`/rw/motionsystem/mechunits/
ROB_1`, `/rw/rapid/tasks/{task}` — neither has any EGM-related field), so there's no
RWS-visible diagnostic or soft-reset available; a full controller restart is the only fix.
After restarting: the controller comes back in Manual (Reduced) mode with motors in
`guardstop` (same as any restart) — needs a physical switch to Auto + motors on before
retrying, same recovery steps as a normal restart.

**`gofa-egm` (Node.js side)**: `nodes/gofa-egm.js`. Hand-rolled proto2 codec
(`decodeEgmRobot`/`encodeEgmSensor`, exported for `test.js`) — no protobufjs dependency, `ws`
stays the package's only runtime dependency. Verified **byte-for-byte** against reference
bytes generated by the proven `gofa-egm-python` project's `egm_pb2` (compiled from ABB's own
`proto/egm.proto`), not just self-consistency — see the codec tests in `test.js`. Uses Node's
built-in `dgram`, lifecycle modeled on `gofa-subscribe-io.js` (`_stopped` flag, status color
convention, teardown on `node.on('close')`). On `start`: sends `EGMJOINT`; `ERR:EGMJOINT`
means `MainModule.mod` (wrong module) is loaded — surfaced as a specific error, not a hang;
binds UDP and waits up to 2s for the first frame (timeout → check `EGM_PC` config / firewall).
Holds the current pose (echoes feedback back unchanged) until a flow sends a `[j1..j6]` target
— never moves on connect. Output throttled (`throttleMs`, default 100ms) since real EGM frames
arrive every ~24ms, far faster than most flows need. On `stop` (and on `close` if a session was
active): drives the RWS stop/resetpp/start recovery sequence described above, not just silence
— see the mode-exit correction.

**Confirmed live end-to-end, 2026-07-09** (GoFa 12 / OmniCore C30, RobotWare 7.21.0+229):
`gofa-egm` `start` → baseline hold (no motion) → a `+3°` target on joint 6 → real, visible
motion, telemetry converging smoothly from baseline through the full ramp to the new target
→ target set back to baseline → smooth return → `stop` → `PING` confirms TCP mode restored,
repeatably. Also confirmed: `start` while RAPID is stopped fails in ~5s with a clear error, not
a hang; a simulated mid-session Node-RED redeploy (`close()` while streaming) recovers the
robot to TCP mode via the same explicit recovery path. This is also where the mode-exit
correction above and the `bEgmRequested` ordering bug were found and fixed.

**Prerequisites (one-time, not automatable from Node-RED)**: a UDPUC transmission protocol
named `EGM_PC` (RobotStudio → Controller → Configuration → Communication → Transmission
Protocol; Remote Address = the Node-RED host's IP on the robot's subnet, Remote Port =
`gofa-egm`'s configured UDP port, default 6510; needs a controller restart), and a firewall
rule on the Node-RED host allowing inbound UDP on that port. **The Remote Address drifts the
same way the robot's own IP does** (see the robot-IP-drift note elsewhere in this doc) —
confirmed live: `start` bound UDP fine and got `OK:EGMJOINT`, but zero frames ever arrived and
RAPID hung indefinitely (see the mode-exit correction — nothing timed out on its own), because
`EGM_PC`'s Remote Address was stale from a prior session's dev-PC IP. Symptom is exactly "no
EGM frames received within 2s" from `gofa-egm` despite the module/mastership/firewall all being
correct — check `EGM_PC`'s configured Remote Address against the Node-RED host's *current* IP
before assuming anything else is wrong.

Full design history and the reasoning behind the two-module decision: see the
`project_egm_node_red_integration_plan` memory and its linked plan file.

## Nodes (41 total)

| Node | Transport | Description |
|------|-----------|-------------|
| `gofa-robot` | config | Shared config: IP, RWS port 443, socket port 1025, creds, local points file, remote (on-robot) points path |
| `gofa-status` | RWS | Reads ctrlstate, opmode, speedratio, RAPID execstate |
| `gofa-pose` | RWS | Current TCP pose (x,y,z + quaternion + config flags) |
| `gofa-joints` | RWS | All 6 joint angles in degrees |
| `gofa-system-info` | RWS | RobotWare version, controller name/ID/type/MAC |
| `gofa-elog` | RWS | Controller event log entries |
| `gofa-motor` | RWS | Motor on/off via `POST /rw/panel/ctrl-state` |
| `gofa-move` | Socket | HOME or SETHOME |
| `gofa-movej` | Socket | Absolute joint move |
| `gofa-jog` | Socket | Cartesian jog (X/Y/Z ± mm or RX/RY/RZ ± °) |
| `gofa-joint-jog` | Socket | Single joint jog |
| `gofa-grip` | RWS | Named DO signal on/off via `/set-value` (needs `Access: All` on that signal) |
| `gofa-zone-set` | Socket | Set path blend zone |
| `gofa-speed-set` | Socket | Speed override % via `SpeedRefresh` (no mastership needed) |
| `gofa-stop-motion` | Socket | Halt motion immediately |
| `gofa-ping` | Socket | Connectivity test, measures round-trip time |
| `gofa-save-point` | RWS + disk/RWS | Read pose via RWS, save as named point in `points.json` (Local) or a JSON file on the robot's own disk (On-Robot) |
| `gofa-go-point` | Socket + disk/RWS | Look up saved point (Local `points.json` or On-Robot file), send GOTO token; move type (MoveJ/MoveL) selectable per-node or per-message |
| `gofa-point-list` | disk/RWS | Output full saved-point array, from `points.json` (Local) or the robot's own disk (On-Robot) |
| `gofa-delete-point` | disk/RWS | Remove a saved point by name, from `points.json` (Local) or the robot's own disk (On-Robot) |
| `gofa-points-export` | disk | Dump points list to `msg.payload` (local storage only) |
| `gofa-points-import` | disk | Replace points list from `msg.payload` (local storage only) |
| `gofa-sequencer` | Socket + disk/RWS | Visit saved points in order (Local `points.json` or On-Robot file); per-step dwell + move type override, loop count, ping-pong, startStep |
| `gofa-stop-seq` | Socket + in-memory | Sets `_seqStop` flag and sends immediate `STOP` socket command |
| `gofa-rapid-exec` | RWS | Start/stop/resetPP/loadmod/unloadmod/activate RAPID program *(requires Remote Start/Stop UAS grants; resetpp/loadmod/unloadmod/activate need Edit mastership, granted automatically)* |
| `gofa-rapid-var-read` | Socket | Read a RAPID PERS variable via `GETVAR:<name>` socket command |
| `gofa-rapid-var-write` | Socket | Write a RAPID PERS variable via `SETVAR:<name>:<value>` socket command |
| `gofa-rapid-tasks` | RWS | List RAPID tasks and the modules loaded in one of them |
| `gofa-file-read` | RWS | Download a file from controller filesystem |
| `gofa-upload-mod` | RWS | Upload a `.mod` file to controller filesystem; auto-syncs `SERVER_IP` to the config node's IP unless disabled |
| `gofa-io-list` | RWS | List all I/O signals |
| `gofa-di-read` | RWS | Read digital input |
| `gofa-do-write` | RWS | Write digital output |
| `gofa-leadthrough-enable` | Socket + RWS | Send STOP (clears queued moves), then activate hand-guiding via RWS |
| `gofa-leadthrough-disable` | RWS | Deactivate hand-guiding |
| `gofa-asi-led` | Socket | Set ASI status light RGB color + counted software blink via `SETLED` / `RESETLED` |
| `gofa-subscribe-state` | RWS WS | Push on every controller state change; one-shot mode polls once per inject |
| `gofa-subscribe-io` | RWS WS | Push on every I/O signal change (real WebSocket push, confirmed live down to a single button tap); falls back to 500 ms polling only if the subscribe request itself fails; one-shot mode available |
| `gofa-subscribe-var` | RWS poll | Poll a RAPID variable on an interval; toggles on/off per inject |
| `gofa-subscribe-pose` | RWS poll | Poll TCP position on an interval; stops if inject has no payload |
| `gofa-egm` | Socket + UDP (EGM) | Sub-10ms joint-position streaming; sends `EGMJOINT` to switch mode, then holds/streams via UDP. Requires `MainModuleEGM.mod` loaded, not the default `MainModule.mod` — see EGM section above |

## Saved points format

Stored in `points.json` on the Node-RED host by default (local storage):
```json
[{ "id": "uuid", "name": "pick1", "target": { "x":323.2, "y":-81.8, "z":807.0, "q1":0.267, "q2":0.129, "q3":0.954, "q4":-0.053, "cf1":-1, "cf4":-1, "cf6":0, "cfx":0 } }]
```
GOTO token rounds to 1 dp (xyz) / 4 dp (quaternion) to stay under RAPID's 80-char string limit. RAPID re-normalizes the quaternion on receipt.

**On-robot storage note**: `gofa-save-point`/`gofa-go-point`/`gofa-delete-point`/`gofa-point-list`/`gofa-sequencer` all have a **Storage: Local / On-Robot** option (`msg.payload.storage` override, `'local'`/`'remote'`). On-Robot stores the exact same JSON shape above in a file on the robot controller's own disk (`gofa-robot`'s **Remote Points Path**, default `$HOME/Programs/gofa_points.json`) instead of `points.json` — no local file needed on the Node-RED host. This does **not** touch `MainModule.mod` or RAPID at all: the file is managed purely over RWS `fileservice` `GET`/`PUT` (`gofa-robot.js`'s `remoteGetPoints`/`remoteAddPoint`/`remoteDeletePoint`/`remoteFindPoint`/`remoteSavePoints`), the exact mechanism `gofa-upload-mod`/`gofa-file-read` already use. Movement is completely unaffected either way — `gotoToken()`/`socketSend()` and the `GOTOJ`/`GOTOL` socket protocol don't know or care where the point came from.

Originally considered storing the list *inside* RAPID (new socket commands reading/writing a file from within `MainModule.mod`), but RAPID's `string` type has a hard 80-character cap (see the GOTO-token rounding above) that a growing list of named points would blow past for more than a point or two — confirmed live: `GET`/`PUT /fileservice/$HOME/Programs/gofa_points_test.json` round-trips a JSON list with no RAPID string involved at all (plain HTTP), which sidesteps the limit entirely. Two things confirmed live building this: `GET` on a missing file is a clean `404` (`rapi_file_service.cpp: Path does not exist`) — treated as `[]`; `PUT` **requires** `Content-Type: text/plain;v=2.0` or `application/octet-stream;v=2.0` — `application/json` is rejected (`415`, and the error body itself names the two valid options). No concurrent-write protection on the remote file (unlike local storage's changed-on-disk mtime check) — acceptable for a human-paced "teach a point" workflow, not built.

## RWS key endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `GET /rw/panel/ctrl-state` | GET | `ctrlstate`: motoron/motoroff/guardstop/emergencystop |
| `GET /rw/panel/opmode` | GET | `opmode`: auto/manualreduced/manualfull |
| `GET /rw/panel/speedratio` | GET | `speedratio`: 0–100 |
| `GET /rw/rapid/execution` | GET | `ctrlexecstate`: running/stopped |
| `GET /rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base` | GET | x,y,z mm + q1..q4 + cf1,cf4,cf6,cfx |
| `GET /rw/motionsystem/mechunits/ROB_1/jointtarget` | GET | rax_1..rax_6 degrees |
| `POST /rw/panel/ctrl-state` | POST | body: `ctrl-state=motoron` or `ctrl-state=motoroff` |
| `POST /rw/rapid/execution/start` · `/stop` · `/resetpp` | POST | *(requires Remote Start/Stop UAS grants; resetpp also needs edit mastership — acquired automatically)* |
| `PUT /fileservice/$HOME/Programs/<file>` | PUT | Upload file to controller |
| `GET /rw/rapid/tasks` | GET | List of RAPID tasks: name, type, taskstate, excstate, active, motiontask |
| `GET /rw/rapid/tasks/{task}/modules` | GET | Modules loaded in a task: name, type (ProgMod/SysMod) |

## Default connection settings (this lab's robot)

| Setting | Value |
|---------|-------|
| Robot IP | `192.168.20.33` |
| RWS port | `443` (HTTPS, self-signed cert — `rejectUnauthorized: false`) |
| Socket port | `1025` |
| Username | `NNNN` |
| Password | *(not written in this repo — see the `user-robot-credentials` live memory; it's still the ABB factory default, and `check-status.js`/`mastership-test.js` fall back to it, so live tests work with no env setup)* |

The *shipped* `gofa-robot` node default was genericized for the public npm release (2026-07-08):
username defaults to ABB's factory `Default User`, password has no default — so a fresh public
install never carries this lab's creds. This repo is public: don't write the actual password
into any tracked file; it lives in the local (non-repo) Claude memory only.

## Software versions (confirmed live, 2026-07-07)

| | |
|---|---|
| RobotWare | `7.21.0+229` |
| RWS protocol generation | `2.0` (path-based actions, `/set-value` not `/set`, `hal+json;v=2.0` for `loadmod`/`activate`) |
| Controller | OmniCore C30 Type A, identity `15000-501318` |
| Robot | CRB 15000-12/1.27 (GoFa 12) |
| RobotStudio (engineering tool, used for I/O config) | `2026.2`, build `26.2.11700.0` |
| Node-RED | `5.0.1` | 
| Node.js | `v22.9.0` |

Full product/option breakdown (RobotOS, ASI, EGM/Multitasking licensing, etc.) is in the `abb-rws` skill's version-snapshot section — re-pull via `GET /rw/system` + `GET /rw/system/products` rather than trusting this table blind after any ABB software update.

## Repo layout

```
node-red-contrib-abb-gofa/        ← npm palette package
node-red-contrib-abb-gofa/check-status.js  ← standalone robot preflight check, see /robot-status above
node-red-contrib-abb-gofa/mastership-test.js ← standalone mastership-gated RWS test, see /mastership-test above
rapid/MainModule.mod               ← RAPID socket server (must run on controller)
rapid/MainModuleEGM.mod            ← optional: MainModule.mod clone + EGM mode (gofa-egm), see EGM section
flows/gofa_demo_flow.json          ← one inject per node, for testing
flows/dashboard_flow.json          ← full robot control palette flow
flows/teach_workflow_flow.json     ← physical ASI-button teach workflow (own tab/config, see README)
MANUAL_CONTROL.md                  ← curl/raw-TCP command reference for controlling the robot without Node-RED
.claude/commands/                  ← skills (/abb-rws, /omnicore-c30, /crb15000, /robot-status, /mastership-test)
.claude/memory/                    ← portable snapshot of Claude Code's project memory - read MEMORY.md first, see its README
.claude/plans/                     ← portable snapshot of past feature plans (design history, not active todos)
```

**On continuity across machines**: this project's Claude Code memory (hard-won lessons, decisions,
live-test history) normally lives outside the repo, keyed to the local clone's working-directory
path — it doesn't travel when this repo is cloned elsewhere. `.claude/memory/` and `.claude/plans/`
are manually-copied snapshots of that history, committed to the repo so a fresh clone (new
machine, or anyone else picking this up) starts with the same context instead of from zero. They
go stale the moment new memory accumulates outside them — worth re-syncing periodically, not just
once. Start any "what's the history here" question with `.claude/memory/MEMORY.md`.
