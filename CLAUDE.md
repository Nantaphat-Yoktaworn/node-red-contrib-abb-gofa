# ABB GoFa 12 (CRB 15000-12/1.27) — Claude Code Context

Custom Node-RED palette (`node-red-contrib-abb-gofa`) for controlling an ABB GoFa 12 (CRB 15000-12/1.27) collaborative robot over a local network. No extra ABB licenses required.

## Skills available

- `/abb-rws` — full RWS API reference (endpoints, auth, response parsing)
- `/omnicore-c30` — OmniCore C30 controller specs
- `/crb15000` — GoFa arm specs, joint limits, working range
- `/robot-status` — runs `check-status.js` (below) against the live controller and reports Motors/Mode/RAPID/Speed/Socket; use before any live RWS/socket test, not just when explicitly asked
- `/mastership-test` — runs `mastership-test.js` (below) to live-test any mastership-gated RWS endpoint (`resetpp`, `loadmod`, `activate`, RAPID var writes, or a newly-discovered one); use instead of hand-rolled `curl` any time a task is "try/verify a mastership-gated RWS action live"

## Standalone status-check script

`node-red-contrib-abb-gofa/check-status.js` — plain Node.js, no Node-RED runtime needed. Run directly (`node check-status.js`) to preflight-check the robot before a live test: Motors/Mode/RAPID/Speed via RWS, plus a socket `PING` (the motion socket server only runs while RAPID is actually executing, so `RAPID: stopped` reliably means the socket ping will fail too — that's expected, not a bug). Flags: `--full` (adds RobotWare version, controller identity, `T_ROB1` task state, last 3 error/warning elog entries), `--json`, and `--discover` (scans active IPv4 subnets for any ABB GoFa controllers). If the configured IP is unreachable, it automatically triggers a fallback network scan to discover and test the controller. Connection defaults match this doc's table below, including IP (`192.168.1.103` as of 2026-07-16 — this constant is kept in sync with the table's "last known good" value, but the robot's IP drifts regularly including whole-subnet changes, hence `--discover`); override any of it per-invocation via `GOFA_IP`/`GOFA_RWS_PORT`/`GOFA_SOCKET_PORT`/`GOFA_USERNAME`/`GOFA_PASSWORD` env vars. Exit codes: `0` OK, `1` RWS unreachable, `2` RWS OK but socket unreachable. Built on `createRobotClient()`, a RED-independent factory extracted from `gofa-robot.js`'s session/auth/cookie logic (`GoFaRobotNode` now just delegates to it) — the same "export pure helpers for standalone use" pattern `test.js` already relies on for `parseXhtml`/`gotoToken`/etc.

## Standalone mastership-test script

`node-red-contrib-abb-gofa/mastership-test.js` — plain Node.js, no Node-RED runtime needed. Wraps an arbitrary RWS POST in `createRobotClient()`'s `withMastership()` (acquire edit mastership → call → release, always, one shared session) so ad-hoc live tests of a mastership-gated endpoint can't repeat two mistakes already hit in this project: forgetting `Content-Type` on the empty-body mastership request/release POSTs, and orphaning the lock by testing request/action/release as separate bare-auth `curl` calls with no shared cookie jar (see the `feedback-curl-mastership-needs-shared-cookie-jar` memory). Usage: `MSYS_NO_PATHCONV=1 node mastership-test.js <path> [body] [--hal]` — `MSYS_NO_PATHCONV=1` is required in Git Bash, or the leading `/` in `<path>` gets rewritten into a Windows path before Node sees it; `--hal` sends `Accept: application/hal+json;v=2.0` (needed for `loadmod`/`activate`, see below). Same env var overrides as `check-status.js`. Prefer this over hand-rolled `curl` for any mastership-gated test, per the `/mastership-test` skill above.

## Architecture — two communication layers

**TCP Socket (port 1025)** — motion commands. The RAPID program (`rapid/MainModule.mod`) runs a socket server on the controller. Each Node-RED node opens a fresh TCP connection, sends one newline-terminated request, reads one newline-terminated reply, and closes.

**RWS HTTPS (port 443)** — telemetry and motor control. REST API built into OmniCore. Auth is Basic on first request → cookie thereafter (auto-refresh on 401). All RWS calls go through `rwsGet()`/`rwsPost()` helpers in `gofa-robot.js`. Responses are XHTML; values extracted with `parseXhtml(body, className)`.

Rule: **motion always goes through the socket; read-only data and motor control go through RWS.**

**The socket's wire format is JSON, not plain text.** A request looks like `{"cmd":"ping"}\n`; a reply looks like `{"status":"ok","cmd":"ping"}\n` on success or `{"status":"err","cmd":"...","msg":"..."}\n` on failure. `ServeClient` in `MainModule.mod`/`MainModuleEGM.mod` picks the dispatcher by the first byte of each line: `{` → `DispatchJson` (the real, current protocol), anything else → the original `Dispatch`/`CleanCmd` plain-text parser — kept for backward compatibility, so raw telnet/curl commands like a bare `PING` (see `MANUAL_CONTROL.md`) still work unchanged.

**No Node-RED node file had to change for this.** Every node still calls `gofa-robot.js`'s `socketSend()` with the same legacy string tokens as before (`'PING'`, `'GOTOJ1;2;3;...'`, `'SETVAR:nTestVar:5'`, …); `socketSend()` runs each one through `translateToJSON()` first, which converts it to the real JSON request, sends it, and converts the JSON reply back into the same `OK:<CMD>` / `ERR:<CMD>` / `VAL:<value>` string shape every node already expected — the JSON layer is invisible to node code unless a node deliberately opts into it. A node *can* instead call `socketSend()` with a plain object (`{cmd:'setdo', name:'ABB_SCALABLE_IO_0_DO5', val:1}`) to skip the string-token round-trip — `translateToJSON` passes objects straight through (`JSON.stringify`, no parsing). `gofa-rapid-var-read`/`gofa-rapid-var-write` and `gofa-do-write`'s Socket transport use this object form directly.

**Case-sensitivity gotcha — not universal, but real for one command.** The legacy text protocol is fully case-insensitive (`CleanCmd` upper-cases the *entire* incoming line before dispatch). `DispatchJson` gets the raw JSON string instead, with no blanket uppercasing (that would corrupt string-valued fields like RAPID variable string values) — each JSON command handler normalizes case itself, if at all. `getvar`/`setvar` **do** normalize (`StrMap` upper-cases the `name` field before comparing), so `gofa-rapid-var-read`/`write` work regardless of the variable's declared case (`nTestVar`, `sTestMsg`). `setdo` originally **didn't** — confirmed live that this palette's own mixed-case default signal name failed until `gofa-do-write.js` was fixed to upper-case the name before sending (see the SETDO note below). Moral: don't assume every `DispatchJson` case handles case the same way — check the specific `CASE` block in `MainModule.mod` before assuming a JSON command is case-insensitive.

## RAPID socket protocol

The table below is the **logical command surface** most Node-RED nodes actually send (as a string to `socketSend()`) — `translateToJSON()` converts every one of these to the real JSON wire request before it goes out; see the JSON wire-format note above for what a packet capture would actually show.

| Command | What it does |
|---------|-------------|
| `HOME` | Move to home position |
| `SETHOME` | Capture current pose as home, persist to `HOME:/Programs/gofa_home.cfg` |
| `GOTOJx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveJ (joint-interpolated, 11 `;`-separated numbers) |
| `GOTOLx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveL (straight-line TCP path) |
| `X+20` / `Y-10` / `Z+5` | Translate TCP ±mm in base frame (max 50 mm) |
| `RX+5` / `RY-10` / `RZ+15` | Rotate TCP ±° in tool frame (max 30°) |
| `J1+10` / `J3-5` | Jog single joint ±° (max 30°, joints 1–6) |
| `SPEED50` | Set speed override 1–100% via `VelSet` (not `SpeedRefresh` — see the `SPEED`/`SpeedRefresh` note below) |
| `GETSPEED` | Read the current override back (`C_MOTSET.vel.oride`); replies `VAL:<value>` |
| `MOVEJ<j1;..;j6>` / `MOVEL<j1;..;j6>` | Absolute joint move in degrees — MOVEJ = MoveAbsJ (joint-interpolated), MOVEL = straight-line TCP path to the same joint pose (CalcRobT forward kinematics + MoveL, added 2.1.0; same singularity caveat as GOTOL) |
| `ZONE<name>` | Set path blend zone (FINE / Z1 / Z5 / Z10 / Z20 / Z50 / Z100) |
| `STOP` | Halt motion — immediately for a jog (still `\Conc`), but only *after* the current move finishes for `HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL` (no longer `\Conc` as of 2.4.2 — see the "\Conc queue-depth crash" note below) |
| `PING` | Connectivity test |
| `GRIPON` / `GRIPOFF` | Stub only (no I/O behind it) — kept for manual/raw-socket testing; `gofa-grip` itself now uses RWS `/set-value` instead, same as `gofa-do-write` |
| `GETVAR:<name>` | Read a PERS variable; replies `VAL:<value>` or `ERR:UNKNOWN_VAR` |
| `SETVAR:<name>:<value>` | Write a PERS variable; replies `OK:SETVAR`, `ERR:UNKNOWN_VAR`, or `ERR:PARSE` |
| `SETLED:<r>;<g>;<b>;<period>` | Set ASI status light color (0–255 each) and hardware blink period; replies `OK:SETLED` |
| `RESETLED` | Restore ASI LED to default RAPID-running state (solid green); replies `OK:RESETLED` |
| `SETDO:<name>:<value>` | Set a digital output by RWS signal name (0/1); replies `OK:SETDO`, `ERR:UNKNOWN_SIGNAL`, or `ERR:PARSE` |
| `EGMJOINT` | **`MainModuleEGM.mod` only** — ack `OK:EGMJOINT`, then this task stops serving TCP and blocks in an EGM joint-streaming session until the `gofa-egm` node's UDP session goes quiet, at which point TCP serving resumes. On plain `MainModule.mod` this command doesn't exist and falls through to `ERR:EGMJOINT` like any other unrecognized command — see the EGM section below. |

Ack is sent **before** the motion starts. RAPID error handler (StopMove/ClearPath/StartMove) keeps the server alive on motion faults. **`HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL` are blocking (no `\Conc`) as of 2.4.2** — the RAPID task doesn't serve the next socket command until the current move physically finishes; only jog commands still queue via `\Conc`. See the "`\Conc` queue-depth crash" note below for why.

**GETVAR/SETVAR note**: variable names are uppercased by CleanCmd in RAPID (`nTestVar` → matched as `NTESTVAR`). String values are extracted from `rawclean` (preserves original case/spaces). To expose a new PERS variable, add an `ELSEIF` block in both `TryGetVar` and `TrySetVar` in `MainModule.mod`. Built-in: `nTestVar` (num), `sTestMsg` (string).

**SETLED/RESETLED note**: `SetGO`-controlled ASI signals via `TrySetLed`/`DispatchJson`'s `setled` case in `MainModule.mod`, `SetGO` on `Asi1LedRed`, `Asi1LedGreen`, `Asi1LedBlue`, `Asi1LedPeriod`. Software-controlled counted blink (Node-RED side) is handled by `gofa-asi-led` when `blinkCount > 0`; in that case `period` is ignored and set to 0. `gofa-asi-led` has three transports as of 2026-07-17 — Socket (`MainModule.mod`/`T_ROB1`, the original), RWS (`/set-value`, added first — works in principle but this controller's ASI board doesn't expose an editable `Access Level` at all, confirmed live, so RWS is a dead end **on this specific hardware**; kept for controllers where it isn't), and Background task (`BackgroundLed.mod` in its own RAPID task, the one actually wired into the teach workflow — see the "Background LED task" section below for why and how).

**RWS I/O write note — `/set-value` is the real action, not `/set`.** `gofa-do-write`/`gofa-ao-write` used `POST /rw/iosystem/signals/{name}/set` for a long time; that path is simply wrong on this OmniCore controller (`OPTIONS` on it is `404`; POSTing it is `405 rws_resource.cpp[472]: HTTP method not supported by resource`, on *every* signal, not just restricted ones). That `405` was misread as "RWS can't write I/O on this firmware at all" — a real DSQC1030 test session got 6 variants of `405` in a row (path-based `/set`, IRC5 `?action=set`, direct `PUT`, `hal+json` Accept, a `/simulated` sub-resource guess) and concluded RWS write was dead, leading to the `SETDO` socket command below as a workaround. **That conclusion was wrong.** The real action, found via ABB's own community forum, is **`POST /rw/iosystem/signals/{name}/set-value`** (body `lvalue=<value>`) — confirmed live: `204` success on a signal with `Access: All`, `403` (correctly) on one still at `Access: Default`. `gofa-do-write.js`/`gofa-ao-write.js` are now fixed to call `/set-value`; re-verified by exercising the real node code (not just curl) against `ABB_Scalable_IO_0_DO5`. **Access level still needs to be `All`** (via RobotStudio `Controller` → `Configuration` → `I/O System` → `Signal` → `Access Level`, needs a controller restart) for RWS write to work on a given signal — that part of the original diagnosis was always correct, only the endpoint name was wrong.

**SETDO note (kept as a working alternative, no longer the only option)**: `TrySetDo` in `MainModule.mod` adds a `SETDO:<name>:<value>` socket command using RAPID's `SetDO` against an explicit per-signal allow-list (`ABB_Scalable_IO_0_DO1`..`DO16` — same pattern as `TryGetVar`/`TrySetVar`, since RAPID can't resolve an arbitrary runtime string into a signal reference). Confirmed live end-to-end: socket `SETDO:ABB_SCALABLE_IO_0_DO1:1` → `OK:SETDO`, independently verified via an RWS read showing `lvalue: 1`; set back to `0`, re-verified; also confirmed unaffected by the signal's RWS `Access` level (works identically on `Default` and `All`, since RAPID itself always has `Rapid` access). Unknown signal name → `ERR:UNKNOWN_SIGNAL`; bad value → `ERR:PARSE`. Useful when you don't want to open a signal's `Access` to `All` (which permits any RWS client to write it) but still want Node-RED control.

**`gofa-do-write` Transport dropdown (2026-07-10)**: `gofa-do-write` now has a **Transport** option — **RWS** (default, `/set-value`, needs `Access: All`) or **Socket** (needs RAPID running, bypasses the Access Level restriction). The Socket option sends `{cmd:'setdo', name, val}` through `socketSend`, which reaches `DispatchJson`'s `"setdo"` case (added during the JSON socket-protocol rewrite) — **not** the legacy `TrySetDo` described above. This matters because `DispatchJson` matches the signal name **case-sensitively** against its ALL-CAPS `TEST` block, with no `CleanCmd`-style uppercasing (`CleanCmd` only runs on the legacy text protocol, and `DispatchJson` gets the raw JSON string, since blindly uppercasing would corrupt string-valued JSON fields). Confirmed live: sending this palette's own default signal name verbatim, `ABB_Scalable_IO_0_DO5` (mixed case), gets `ERR:SETDO` ("unknown signal"); the all-caps `ABB_SCALABLE_IO_0_DO5` succeeds. Fixed in `gofa-do-write.js` by upper-casing the name before sending over Socket — confirmed live end-to-end (via the real node code, not curl) that this now writes correctly, independently re-verified with an RWS read of `lvalue` after each write.

**Analog nodes removed (2026-07-07)**: `gofa-ai-read`/`gofa-ao-write` were deleted — confirmed live that this controller has zero `AI`/`AO` signals anywhere (only `DI`/`DO`/`GO` exist; the DSQC1030 is digital-only, and the C30 has no native analog port). Analog I/O would need ABB's `DSQC1032` Analog Add-On module, which attaches to the existing DSQC1030 digital base device rather than replacing it (see the `dsqc1030-scalable-io-addressing` memory). Re-add these nodes (same `/set-value`/plain-GET pattern as `gofa-do-write`/`gofa-di-read`) if that module is ever installed.

**`gofa-backup` and `gofa-restart` removed (2026-07-14)**: both nodes were added, then dropped after live testing showed the same failure. ABB's own documented backup-trigger call, `POST /ctrl/backup?action=backup` (verified against ABB's current Developer Center docs), returns a hard `405 Method Not Allowed` on this controller (RobotWare 7.21.0+229) — `OPTIONS /ctrl/backup` reports `Allow: GET,OPTIONS` only, no POST, regardless of the `?action=backup` query string, `Accept` header (tried `hal+json` too, same 405 pattern as `loadmod`), or HTTP verb (`PUT` also 405s). `/ctrl/backup/state` itself reads fine (`Backup Ready`), so the feature exists on this controller — only the documented create-call doesn't work as written. `gofa-restart`'s `POST /ctrl` (body `restart-mode=<mode>`) looked more solid on paper — code review reproduced ABB's own sample curl call verbatim and it matched exactly — but it **also** 405s live, despite `OPTIONS /ctrl` reporting `Allow: GET,POST,OPTIONS` (POST supposedly valid). Confirmed via the actual dashboard flow's `/robot/restart` HTTP endpoint, not just a raw curl guess. Same shape as the `/rw/rapid/symbols` finding above: ABB's own current docs failing verbatim against live, current firmware, and this time the "Allow header lies" pattern hit twice in one session on two different `/ctrl*` resources. Not investigated further (no working alternate path found for either); re-add only if a working trigger call is confirmed live first.

**SERVER_IP note**: `MainModule.mod` binds its socket server with `CONST string SERVER_IP := "..."`, which RAPID's `SocketBind` requires to be a real configured interface address (no wildcard bind). If this drifts from the controller's actual IP, `SocketBind` silently fails and every socket command times out with no error on the controller side. `gofa-file`'s upload action (and `gofa-setup`/`gofa-mod-edit`) mitigates this by always rewriting `SERVER_IP` to the `gofa-robot` config node's IP on every upload (`patchServerIp` no-ops on any file that doesn't contain the constant, so this is safe for uploading other files too); the constant in the repo copy is just the fallback for a first upload or manual FlexPendant/SD-card load.

**Module reload (`loadmod`) note**: reloading a module file already on disk into a running task (the FlexPendant's **Load Module** step) *is* possible over RWS, but not via the documented RWS 1.0/IRC5 query-action form — `POST /rw/rapid/tasks/{task}?action=loadmod` is `405` on this controller (same red-herring `Allow: GET,POST,OPTIONS` header as the `/rw/rapid/symbols` case below; that resource's real POST use is `/subscription`). The working call is **path-based**: `POST /rw/rapid/tasks/{task}/loadmod`, body `modulepath=<path>&replace=true`, and — the one exception in this whole palette — it requires `Accept: application/hal+json;v=2.0`, not the `xhtml+xml` every other endpoint uses (xhtml Accept errors on this resource). Gated on edit mastership, same as `resetpp`. Confirmed live against `T_ROB1`/`MainModule` (RobotWare 7.21.0+229): `200` with JSON body `{"state":[{"name":"MainModule", ...}]}`, no side effects. `gofa-rapid-exec`'s `loadmod` action wraps this (`rwsPostHal` in `gofa-robot.js` sends the hal+json Accept header). A companion `activate` action (`POST /rw/rapid/tasks/{task}/activate`, body `module=<name>`) works the same way and is now also wired into `gofa-rapid-exec`, as does `unloadmod` (`POST /rw/rapid/tasks/{task}/unloadmod`, body `module=<name>` — same hal+json/mastership requirements; removes the named module from the task only, the file stays on the controller's disk). `unloadmod` was needed once it was confirmed live that `loadmod`'s `replace` only replaces a *same-named* module — loading `MainModuleEGM` while `MainModule` is still loaded leaves both loaded, both declaring `PROC main()`, and RAPID rejects `resetpp`/`start` with `(87,5): Global routine name main ambiguous` (see the EGM section below). **All three require RAPID to be stopped** — confirmed live in both directions: succeeds (`204`) with `ctrlexecstate: stopped`, fails `403` (`rws_resource_rapid_task.cpp: Operation not allowed for current PGM state`) with `ctrlexecstate: running`, on the identical call. `gofa-rapid-exec` surfaces the RWS error's own reason text (previously discarded — `gofa-robot.js`'s `request()` only threw `HTTP <code> <path>` with no body detail) and adds a specific hint for this rejection. Full test log: see the `abb-rws` skill and the `project_robot_live_test_log` memory.

**GOTOJ/GOTOL note**: bare `GOTO<11 nums>` (no `J`/`L` letter) is still accepted by `TryGoTo` as an alias for `GOTOJ`, for backward compatibility. `gofa-go-point` and `gofa-sequencer` always send the explicit `J`/`L` form based on their "Move type" dropdown. `MoveJ` (joint-interpolated) is the more predictable/reliable choice — RAPID has freedom in how each axis gets there, so it won't fault or slow drastically near a singularity — and is therefore the default at every fallback point: `gotoToken(t, moveType)` in `gofa-robot.js` maps anything other than exactly `'L'` to `'J'`, and both nodes' config defaults are `'J'`. `MoveL` follows a straight line to the target and can hit singularities or joint limits along that line that `MoveJ` would route around, so it's opt-in, not a safer default.

**Joint soft-limit note (added 2.4.9)**: `gofa-movej` validates every absolute-joint target against per-axis soft limits *before* sending, so an out-of-range value returns a clean `{ok:false, error, joint, value, min, max}` and never reaches the robot — instead of provoking a RAPID motion fault (which the `ServeClient` ERROR handler recovers from, but a fault-and-recover cycle is not a proper rejection path). Limits live on the `gofa-robot` config node's optional **Joint Limits** field and default to the CRB 15000-12/1.27 hardware working range (`JOINT_LIMITS` in `gofa-robot.js`: J1 ±270, J2 ±180, J3 −225/+85, J4 ±180, J5 ±180, J6 ±270, from product manual 3HAC077389-001). Because the defaults are the *true* hardware ranges, validation only rejects targets `MoveAbsJ` would fault on anyway — it never blocks a move the robot could actually reach; a cell with tighter RobotStudio axis limits can set a JSON override (six `[min,max]` pairs, malformed → warn + fall back to defaults, never silently disabled). `validateJoints`/`parseJointLimits`/`JOINT_LIMITS` are exported from `gofa-robot.js` and used by both `gofa-movej`'s runtime handler and its `/move` admin endpoint. **Does NOT apply to Cartesian moves** (`gofa-go-point`/`GOTOJ`): a robtarget's joint angles aren't known without inverse kinematics, which isn't available node-side, so those still rely on RAPID's fault handling. The raw-socket `MOVEJ`/`MOVEL` tokens (manual testing, `MANUAL_CONTROL.md`) also bypass this — RAPID itself does no soft-limit check; the validation is purely node-side. Live-verified 2026-07-22 against the real robot: an out-of-range `MOVEJ` (J3=100°) rejected in ~1ms with zero controller contact, an in-range one passed the gate and reached the socket.

**`SPEED`/`SpeedRefresh` note — `gofa-speed-set` and RWS `speedratio` are two SEPARATE
multiplicative overrides, confirmed live 2026-07-21, correcting an earlier wrong claim in this
doc.** This project previously described `gofa-speed-set`'s `SpeedRefresh` call as "the same as
the speed slider on the FlexPendant." Confirmed false via a live round-trip: `gofa-speed-set`
Set(40) → `SpeedRefresh 40` acked `OK:SPEED` → an immediate RWS read of `GET
/rw/panel/speedratio` still reported `100`. Per ABB's own RAPID reference and community forum
discussion, `SpeedRefresh` and the FlexPendant/production-window override (what `speedratio`
reports) are independent factors — actual motion speed is roughly `programmed speed ×
FlexPendant override% × SpeedRefresh override%`, not one value under two names. Practical
implications: **there is no known RWS-readable value for `SpeedRefresh`'s own override** — the
`gofa-speed-set` "Read" action (added 2026-07-21) reads `speedratio` only, which is a real, useful
value on its own (the operator's dial position) but can never be used to confirm a prior `Set`
call took effect; confirming that needs watching actual motion speed, not an RWS read. Both
values remain global/controller-wide either way — `SpeedRefresh` still affects every subsequent
move from any flow or node, same caution as before, just via a different mechanism than
previously documented.

**Follow-up, same day — `SpeedRefresh` called from the idle socket handler (i.e. every real
`gofa-speed-set` Set call today) shows NO measurable effect on real motion duration when timed
live. Treat `gofa-speed-set` as unproven to actually control speed, pending a redesign.** Method:
since `MOVEJ`/`MOVEL` are blocking (no `\Conc`, 2.4.2) and the ack is sent before the move runs,
a single command's own round-trip isn't a valid timing signal — but RAPID can't accept the
*next* connection until the current blocking move finishes, so the next command's round-trip
measures the *previous* move's real duration. Timed a 30° out-and-back `MOVEJ` on joint 6 (same
low-risk axis prior EGM tests used) via the real `gofa-speed-set`/`gofa-movej` node code: at
`SpeedRefresh 100` the move took ~487–492ms; at `SpeedRefresh 10` the same move took ~372ms —
essentially flat, not the ~10x slowdown a working override would produce, and if anything
backwards. This matches ABB's own documented semantics (RAPID technical reference + community
forum, see the note above): `SpeedRefresh` updates the override for a movement *already in
progress* — calling it from an idle handler, before the next move even starts, likely does
nothing because there's no active motion for it to refresh at that moment. **A second,
higher-contrast run (100% vs 5%) was contaminated by what looks like independent concurrent
activity on the same robot** — a genuine "Corner path failure" elog entry (domain 5/Motion,
`/MainModuleEGM/DispatchJson/MoveAbsJ/422`) and a steady stream of `T_ROB1`/`T_LED` "Socket
error... closed by remote host" entries appeared in exactly that test's time window, consistent
with another already-deployed flow (e.g. `watchdog_flow.json`'s 30s poll) or user session hitting
the robot concurrently — not something the test script alone would produce. That run's numbers
are unreliable and were discarded; the first, clean run's flat/backwards result stands as the
evidence. Robot was confirmed to settle back at its exact starting joint values and to stay
`motoron`/`AUTO`/`running` throughout, both times — no safety issue, just data worth distrusting
in the contaminated run.

**RESOLVED same day — `gofa-speed-set` now uses `VelSet` instead of `SpeedRefresh`, confirmed
live to actually control real motion speed. Bumped to 2.4.6.** `MainModule.mod`/
`MainModuleEGM.mod`'s `"speed"` JSON case now calls `VelSet speedVal, 5000;` instead of
`SpeedRefresh speedVal;` — per ABB's own RAPID reference, `VelSet` changes the *programmed*
velocity, persisting to every subsequent motion instruction until changed again (unlike
`SpeedRefresh`, which only updates an already-in-progress move). The `5000` second argument is a
generously high absolute TCP-speed cap (mm/s) — above any `v_tcp` this project's `vGoto`/`vJog`
ever specify — so it never becomes the binding constraint; only the override% matters, the same
role `SpeedRefresh`'s single argument was meant to play. **Live-verified with the same
before/after-move timing method as the `SpeedRefresh` test above**: a 30° out-and-back `MOVEJ` on
joint 6 took ~37ms total at 100% override vs. ~2216ms at 5% — a **60x** difference, unambiguous
real scaling (a working override only needed to show ~20x). Robot settled back at its exact
starting joint values both times, `motoron`/`AUTO`/`running` throughout.

A new `"getspeed"` JSON case (`gofa-speed-set`'s Read action now uses this instead of RWS
`speedratio`) reads `C_MOTSET.vel.oride` — the predefined system data holding `VelSet`'s current
override — and replies `VAL:<n>` same as `GETVAR`. **First attempt used `CMotSet` (no
underscore) and failed to compile** (`resetpp` → `HTTP 400`, elog `40160 "Errors in RAPID
program"`, no line-level detail available over RWS) — bisected by removing just the `getspeed`
case and redeploying: `VelSet`-only compiled clean, confirming the fault was isolated to that one
identifier. Retried with `C_MOTSET` (underscore) per multiple independent web sources — compiled
and deployed clean. Live-verified the full Set→Read round trip via the real `gofa-speed-set` node
code: Set 37 → Read 37, Set 63 (via `msg.payload.speed` object-form override) → Read 63, restore
Set 100 → Read 100, every pair matching exactly (an isolated single earlier read momentarily
showed a stale `37` before any of this test's own `Set` calls ran — never reproduced again across
three independent follow-up reads, consistent with the same kind of external concurrent activity
already documented above, not a bug in this mechanism). Ended the session with the override
confirmed back at `100` and the robot `motoron`/`AUTO`/`running`.

Both `MainModule.mod` and `MainModuleEGM.mod` carry the identical fix (kept in lockstep per this
doc's own sync rule); only `MainModuleEGM.mod` was live-deployed and tested this session (it's
what the controller was already running) — `MainModule.mod`'s copy is byte-identical in this
region but its own live compile/deploy wasn't separately re-verified.

**Follow-up review pass, same day, bumped to 2.4.7 — found the identical `SpeedRefresh` bug
still alive in a second, separate code path.** After 2.4.6 was published to npm, a repo-wide
audit (`grep -rn SpeedRefresh`) turned up `TrySpeed` — the **legacy plain-text protocol**
handler for the raw `SPEEDnn` token (`Dispatch`/`CleanCmd`, used for manual telnet/curl testing
per `MANUAL_CONTROL.md`, completely separate from `DispatchJson`'s `"speed"` case fixed above)
— still called `SpeedRefresh spd;`, unfixed. **This never affected `gofa-speed-set` or any
Node-RED usage** — `gofa-robot.js`'s `translateToJSON()` always converts a `SPEEDnn` string to
the JSON `{cmd:'speed'}` form before it reaches the socket, so the Node-RED palette never
actually invokes `TrySpeed` — but it was still live, shipped, and documented as working in
`MANUAL_CONTROL.md`'s manual-testing table, so it got the same `VelSet spd, 5000;` fix. Also
added a `GETSPEED` case to the legacy `Dispatch` (mirroring the JSON `getspeed` command, same
`C_MOTSET.vel.oride` read) — `MANUAL_CONTROL.md`'s table only documents commands that genuinely
work via raw `nc`/telnet, so `GETSPEED` needed a real legacy-text implementation, not just a doc
mention. **Confirmed live via a raw TCP script (bypassing the JSON layer and the Node-RED node
code entirely, i.e. exactly what `MANUAL_CONTROL.md` tells a manual tester to do)**: `SPEED37` →
`GETSPEED` → `VAL:37.00` → `SPEED100` → `GETSPEED` → `VAL:100.00`. Same repo-wide audit also
added a doc clarification to `gofa-status`/`gofa-connection-status`'s help text (their `speed`
field reads RWS `speedratio`, the FlexPendant value — same "these are two different things"
caveat as everywhere else in this note) and corrected `.claude/commands/abb-rws.md`'s API
reference, which still said `gofa-speed-set` used `SpeedRefresh`.

**`\Conc` queue-depth crash, fixed 2026-07-20 — a real production bug, not a one-off.** User report: `pickplace_sorting_flow.json` worked once, then RAPID error **40631** ("Too many move instructions in sequence with concurrent RAPID program execution") on the second cycle, stopping `T_ROB1` (and its own socket server with it — full `gofa-setup` redeploy needed to recover, not just `resetpp`). Every chained motion instruction (`HOME`, `GOTOJ`/`GOTOL`, `MOVEJ`/`MOVEL`) used RAPID's `\Conc` switch so the ack could return before the physical move finished; a helper `PROC AddConcMove()` was meant to call `WaitRob \InPos` periodically to keep the RAPID-internal `\Conc` queue-depth limit from being exceeded. **Five independent live-tested fixes all failed at the identical move** (same failure point regardless of zone type, sync threshold, an off-by-one in the counter, syncing on literally every move, or agy's ABB-informed `WaitTime 0.1` + `WaitRob \InPos` fix) — including with 5mm test moves between two points sharing an identical `robconf` (ruling out kinematics/singularity entirely) and with request pacing from 0s to 4s apart (ruling out a client-side race). That level of consistency across five structurally different sync strategies meant `WaitRob \InPos`, called from a helper `PROC`, simply wasn't resetting whatever RAPID actually tracks for this limit — not a tuning problem. **Fix, confirmed live (20/20 clean cycles after, vs. 100% failure by move 7 before)**: removed `\Conc` entirely from `rGoHome`, `TryGoTo`, `TryMoveJ`, and the JSON `goto`/`movej`/`movel` handlers, in both `MainModule.mod` and `MainModuleEGM.mod`. The ack is already sent before the move runs, so this is invisible to Node-RED — RAPID just finishes each move before serving the next socket command instead of racing ahead. The now-fully-unused `AddConcMove`/`concCount` machinery was deleted. Jog commands (`X±`/`Y±`/`Z±`/`RX±`/`RY±`/`RZ±`/`J1-6±`, the JSON `jog`/`jointjog` cases) were untouched — each already does a full `StopMove`/`ClearPath`/`StartMove` reset before its own single `\Conc` move, so they were never exposed to this bug and can still be interrupted mid-move by `STOP`. **Trade-off, deliberately accepted**: `STOP`/`gofa-stop-motion` can no longer interrupt an already-executing `HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL` — it now only cancels a move that hasn't started yet, taking effect once the current one finishes. The safety controller's own hardware e-stop is completely independent of this software layer either way. Bumped to 2.4.2 (`MODULE_VERSION` in all three `.mod` files, kept in lockstep with `package.json` per the version-handshake rule, even though `BackgroundLed.mod`'s own content didn't change — it tracks the palette version as a single number for drift detection, not its own independent history).

**RAPID start note**: `POST /rw/rapid/execution/start` returns HTTP 200 even when the controller immediately rejects the start (e.g. RAPID error 20055, "program must start in Motor On state") — the rejection isn't surfaced as an HTTP error, so a naive implementation reports `{ ok: true }` for a start that never ran. `gofa-rapid-exec` guards against this for the `start` action only: it reads `/rw/panel/ctrl-state` first and fails fast if motors aren't on, then polls `/rw/rapid/execution` (`ctrlexecstate`) for up to 1.5s after the POST to confirm it actually reached `running`. `stop`/`resetpp` don't have this silent-rejection failure mode and aren't checked.

**RAPID symbol data note**: RWS's generic `/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}` (the RWS 1.0 / IRC5-era documented endpoint for reading/writing any RAPID variable without touching RAPID code) returns `404 SYS_CTRL_E_UNRESOLVED_URL` on this controller. **Not a licensing issue** — verified against ABB's OmniCore C-line product manual (3HAC065034-001) that RWS is a standard, base-included feature, and that the OmniCore option in this area, RobotStudio Connect [3119-1], is unrelated (it's about the RobotStudio desktop app connecting over WAN). The real cause: `GET /rw/rapid` on this controller advertises `symbols` (plural), a search-based resource, not the flat singular `symbol` path from the general RWS docs — the same RWS 1.0-vs-2.0 shape split already seen for `execution` and `iosystem`. **Confirmed impossible, not just unresolved** — a later session fetched ABB's own current Developer Center pages for the exact official `search-symbols` call (method, path, query, form body) and reproduced it verbatim against the live controller (RobotWare 7.21.0+229): `POST /rw/rapid/symbols?action=search-symbols` with ABB's own documented body still returns `405 Method Not Allowed`, despite the response's own `Allow: GET,POST,OPTIONS` header claiming POST is valid; every path/method variant tried (singular action name, path-based action, GET-with-query, module-scoped `symbol` browser) is `404`/`405` or silently empty. This is ABB's own documented syntax failing on live, current firmware — not a guess this time. Full investigation, what was tried, and what's confirmed: see the `abb-rws` and `omnicore-c30` skills. This is why variable read/write goes through the custom TCP `GETVAR:`/`SETVAR:` protocol (allow-listed per variable in `TryGetVar`/`TrySetVar`) — proven and simple, not a workaround for a missing option. `gofa-subscribe-var`'s `readVar()` used to try the dead RWS symbol path before falling back to module-text on every poll; that guaranteed-fail round trip was removed once the endpoint was confirmed permanently broken on this hardware (not just occasionally), so it now goes straight to module-text and always reports `source: 'module-text'`.

**IO subscription note**: `gofa-subscribe-io`'s WebSocket subscribe request used resource suffix `;lvalue` (matching the attribute name a plain GET returns), but OmniCore's subscription service doesn't work that way — each RWS resource has its own fixed subscribable-resource keyword (`gofa-subscribe-state` already had this right, using `;ctrlstate` for `/rw/panel/ctrl-state`), and for I/O signals that keyword is the literal `;state`, not the value's own class name. `;lvalue` always got `400 Invalid resource URI` — confirmed live on both a top-level signal (`GOFA_MotorsOn`) and a device-scoped one (`Asi1Button2`), same path, only the suffix differed between 400 and 201. The `.catch` on that 400 fell through to 500 ms polling with no warning, so **every** signal was silently polling, not just ones that "lack WS support" (that was never a real distinction — no signal in this controller's IO list is WS-incapable; the request was just malformed). Fixed by changing the suffix to `;state`; re-verified by loading the actual patched node file and pressing `Asi1Button2` live — it connected as a real WS ("connected" status, not "polling") and pushed `source:'ws'` events with no poll delay on press and release. Practical implication: `gofa-subscribe-io` can now reliably catch fast events (e.g. a physical button tap) that a 500 ms poll could miss — worth revisiting anywhere the palette currently polls I/O as a workaround for "flaky WS," since that flakiness was this bug, not the hardware.

**Change-only, no initial snapshot — confirmed live 2026-07-20 building `flows/mqtt_bridge_flow.json`.** The WS subscription only pushes on a signal *transition*; it never emits the signal's current value just from connecting. Driving the real node against the real robot, a fresh subscribe on `Asi1Button1`/`Asi1Button2` sat with WS status `connected` and zero output for 4+ seconds with the button untouched — not a bug, just how the RWS subscription service behaves. A second `on('input')` call while already subscribed to the same signal triggers `readOnce()`, a genuine one-off RWS `GET`, which does return the current value regardless of whether it just changed (same as pressing this node's editor panel button twice). Anything that wires `gofa-subscribe-io` to fire once on deploy and expects an immediate current-value output (the MQTT bridge's "Start Bridge" inject, for one) will see that topic stay empty until the signal actually changes at least once — expected, not something to fix.

**Elog subscription note**: `gofa-subscribe-elog`'s subscribable resource is the **bare** `/rw/elog/<domain>` path — no `;suffix` at all, unlike every other subscribe node in this palette (`;ctrlstate` for panel state, `;state` for I/O signals). Confirmed live: every semicolon-suffixed guess (`;elog`, `;state`, `;lvalue`, `;log`) returned `400 Invalid resource URI`; only the bare path returned `201`. Also confirmed live: the WS push only carries a reference (`<li class="elog-message-ev">` with a `seqnum` and a self-`href`, e.g. `/rw/elog/1/17352`), not the entry's fields — the node does a follow-up `GET` on that href (`?lang=en`) to fetch `msgtype`/`code`/`title`/`tstamp` before emitting. That single-entry endpoint uses XHTML class `elog-message` (singular), not `elog-message-li` (the class the bulk list endpoint `gofa-elog` already parses) — same inner `<span>` fields, different wrapping class, so `gofa-subscribe-elog.js`'s `parseEntry()` matches either. End-to-end confirmed live: subscribing, then triggering a real new entry (a second client's fresh RWS login, which itself logs a `10400 "User ... logged on"` event) produced a genuine push → fetch → parse → emit round trip 2 seconds later, not just the initial-connection artifact.

**Elog domain vs. severity note**: `gofa-elog`'s original "Domain" dropdown (`0` = "All domains", `1` = "Controller (errors/warnings)") was never actually verified against the controller and turned out to be wrong on both counts. Confirmed live via `GET /rw/elog`: domain is a fixed ABB category list (`0`=Common, `1`=Operational, `2`=System, `3`=Hardware, `4`=Program, `5`=Motion, `7`=IO & Communication, `8`=User, `9`=Safety, `10`=Internal, `11`=Process, `12`=Configuration, `13`=Paint, `15`=RAPID, `17`=ConnectedServices) — domain `1` is "Operational", not "Controller", and has nothing to do with severity. Domain `0` ("Common") isn't a merge of every domain either: querying it live returned only 15 entries while domain `10` ("Internal") alone reported 97 in its own count — so picking a domain never gets you "all severities across everything," and picking domain `1` never filtered out info-level noise like "Motors On state." Severity (`msgtype`: `1`=info, `2`=warning, `3`=error) is a completely separate field on every entry, unrelated to domain. Both `gofa-elog` and `gofa-subscribe-elog` now have a real **Min Severity** filter (client-side, since RWS's elog endpoint has no severity query param) plus the corrected domain dropdown; confirmed live that `minSeverity=2` against domain `0` correctly cut 27 entries down to the single real warning present, with no false negatives/positives against the visible `msgtype` values.

**ASI buttons note**: the two physical buttons near the GoFa's tool flange are exposed as plain `DI` signals `Asi1Button1` / `Asi1Button2` (`GET /rw/iosystem/signals/Asi1Button{1,2}`, same `lvalue` shape as any other digital input) — readable today with `gofa-di-read` (just set Signal to the name) and subscribable with `gofa-subscribe-io`, no new node needed. This holds **even when the FlexPendant's Wizard menu has a button assigned to a function like "Add a move position"**: confirmed live that a press still produces a real `0→1→0` edge on the RWS signal (both by polling and by WS push) — Wizard reads the same signal rather than claiming it exclusively. Opens the door to a physical "teach" workflow (hand-guide via `gofa-leadthrough` (action enable), tap a button, `gofa-subscribe-io` fires a flow that calls `gofa-save-point`) without touching the FlexPendant screen — not built, just confirmed feasible.

**Module-text fallback is confirmed STALE, not just unverified** (`gofa-rapid-var-read`'s fallback and `gofa-subscribe-var`'s only path — reading `/rw/rapid/tasks/{task}/modules/{module}/text` + fileservice, regex-matching `name := value`): tested live by writing a new value to `nTestVar` via socket `SETVAR`, confirming the write with socket `GETVAR` (got the new value), then reading the same variable through this RWS path — it returned the *original* compiled/declared value, not the one just written. This path reflects the module's compiled state, not the variable's live runtime value. Both nodes now mark it `stale: true` with a `warning` field in the payload instead of presenting it with the same confidence as a live socket-`GETVAR` read (`source: 'socket'`, no `stale` field). There is no known live-value alternative for variables outside the `TryGetVar`/`TrySetVar` allow-list until the `/rw/rapid/symbols` search API (see above) is cracked.

**`gofa-rapid-exec` chaining hazard — clear `msg.payload` between two chained instances.** `gofa-rapid-exec` supports overriding its configured `action` via `msg.payload.action` (or a bare `msg.payload` string) — a deliberate, useful feature. But its own success output is `{ok:true, action:<the action it ran>}`, which has exactly that shape. Wiring one `gofa-rapid-exec` node's output straight into another (even through a passthrough `switch` gate, which doesn't alter the message) makes the second node see the first node's `action` as an override and silently repeat it instead of running its own configured action. Caught live in `flows/teach_workflow_flow.json`: `Reset Program Pointer` (action `resetpp`) wired into `Restart RAPID` (action `start`) via a `switch` gate — `Restart RAPID`'s own debug output showed `{ok:true, action:"resetpp"}`, and RAPID never actually restarted (confirmed via `gofa-status`: `rapid` stayed `stopped`). Fixed by inserting a `change` node that resets `msg.payload` to `{}` between them. This only bites when two `gofa-rapid-exec` nodes are chained with nothing in between that replaces `payload` — a `gofa-status` node in between is safe, since it always overwrites `payload` regardless of what it received.

**`gofa-asi-led` has the same chaining hazard, discovered live 2026-07-20 — a different trigger than `gofa-rapid-exec`'s, easy to miss because it was never noticed until it actually bit a real flow.** Its own success output is `{ok, r, g, b, blinks, transport}`, and `resolvePayload()` treats *any* incoming object with `r`/`g`/`b` fields as a color override (the same deliberate mechanism that lets `msg.payload = {r,g,b}` set an ad-hoc color from upstream logic). Wiring one `gofa-asi-led` node's output straight into another silently makes the second one repeat the first node's color instead of its own configured one. Caught live in `flows/teach_workflow_flow.json`: the "Point Saved" white double-flash was wired straight into a "Restore Teach Idle" node configured for yellow — confirmed via direct RWS polling of `Asi1LedRed/Green/Blue` that the LED stayed white indefinitely (not a hardware/safety-controller override, not a timing issue — a bare `resolvePayload()` call with the blink node's own `{r:255,g:255,b:255,...}` output against yellow-configured defaults reproduces it exactly, and was confirmed live down to the raw signal values, both with and without the fix). Fixed the same way: a `change` node clearing `msg.payload` to `{}` between the two `gofa-asi-led` nodes. General rule for this palette: **any node whose success payload happens to reuse field names that node's own type also accepts as an override is chaining-unsafe** — check before wiring two instances of the same node type back-to-back.

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
`egm_minmax1 := [-10.0, 10.0]` hard clamp → `EGMRunJoint ... \CondTime:=60`). While in EGM
mode the closed server socket makes every other socket-based node fail fast with "connection
refused" instead of hanging.

**Mode exit — FIXED design (2026-07-09), using EGMStop from a RAPID TRAP.** Per ABB's own EGM
Application Manual (3HAC073318): `EGMStop` is a documented instruction specifically meant to
be called "in a TRAP routine" or "from a RAPID TRAP or background task" to end an in-progress
`EGMRunJoint`/`EGMRunPose` **gracefully** — the instruction returns *normally*, unlike an
external task-level kill. `RunEgmJoint` now does `CONNECT egmStopIntNo WITH TrapEgmStop;
ISignalDO ABB_Scalable_IO_0_DO16, 1, egmStopIntNo;` before starting the session; `gofa-egm.js`'s
`stop` action (and `close`, when a session is active) sets that signal via RWS
(`POST /rw/iosystem/signals/ABB_Scalable_IO_0_DO16/set-value`, `lvalue=1`) instead of issuing
an RWS task stop, then polls `PING` until TCP serving resumes as confirmation. `TrapEgmStop`
fires, calls `EGMStop egmID1, EGM_STOP_HOLD;`, `EGMRunJoint` returns normally, and
`RunEgmJoint`'s own cleanup (`IDelete` + `EGMReset`) runs every time — **the RAPID task never
actually stops**, so no `resetpp`/`start` is needed on the Node-RED side anymore either.
Confirmed live: zero "Program stopped"/"Program started" elog events across a full
start→stream→stop cycle — proof the task genuinely stayed running throughout, not just that
`PING` happened to succeed.

**History (superseded, kept for context — do not re-implement the old design):** the original
implementation assumed `\CommTimeout` would raise a comm-timeout error once `gofa-egm` stopped
replying, letting an ERROR handler reset and fall back to TCP serving on its own. Confirmed
FALSE live: going silent left the task blocked inside `EGMRunJoint` for 2+ minutes with no
error and no recovery. The fix at the time was an **external RWS stop**
(`POST /rw/rapid/execution/stop`) → `withMastership(resetpp)` → `start` if motors on — which
worked, but skipped `RunEgmJoint`'s own cleanup entirely (an external kill isn't a RAPID error,
so no ERROR handler runs), which is **why `bEgmRequested` is cleared before calling
`RunEgmJoint`, not after** — that ordering fix is still correct and still needed today, since a
genuinely external stop (FlexPendant, e-stop, etc.) can still interrupt an EGM session the same
way. `\CommTimeout` is still not relied on for anything; `\CondTime:=60` remains a
documentation placeholder / hard backstop only.

**RESOLVED (2026-07-09): the external-stop design leaked one controller-side EGM instance per
cycle, eventually producing RAPID error "Too many EGM instances."** Root cause: an external RWS
stop skips `RunEgmJoint`'s own `EGMReset` (see History above), so the controller-side resource
never got released. RobotWare allows a maximum of **4** concurrent EGM identities (confirmed in
ABB's EGM Application Manual) — confirmed live that ~8 leaked start/stop cycles in 90 seconds
was enough to exhaust the pool. **A hypothesis that a SHORT `\CondTime` would let `EGMRunJoint`
return normally on its own was tested live and disproven** first (with `\CondTime:=6`, a
session killed abruptly stayed blocked 70+ seconds later, 11x+ the configured value, zero
recovery) — the real fix was the TRAP/`EGMStop` mechanism described above, found by reading
ABB's own manual rather than guessing further. **Confirmed fixed live**: 12 consecutive
start/stop cycles (1.5x the count that broke the old design) all succeeded with stable timing
(~80ms start, ~1050ms stop, no drift across cycles) — no instance exhaustion. If "Too many EGM
instances" is ever seen again despite this fix being in place, a full controller restart is
still the only known recovery (EGM/UC state has zero visibility in RWS — checked
`/rw/motionsystem/mechunits/ROB_1` and `/rw/rapid/tasks/{task}`, nothing there either).

**The two notes below predate the TRAP/EGMStop fix and now apply to a narrower case: RAPID
being stopped by something *other* than `gofa-egm.js` itself** (FlexPendant Stop, an
emergency/guard stop, module switching's own `stop`/`unloadmod` sequence) while an EGM session
is active. Normal `gofa-egm` `start`/`stop` usage no longer stops the task at all, so it can't
trigger either of these anymore — but if RAPID is ever externally stopped mid-session, the same
risk exists as before.

**Never resume RAPID with a plain "continue" start after any EGM interruption — always
`resetpp` first.** Confirmed live (2026-07-09): a bare `gofa-rapid-exec` `start` (RWS
`regain=continue`, i.e. "resume from wherever the program pointer is") after an EGM session
had been externally stopped resumed execution *mid-EGM-code* instead of from the top of
`main()` — the program pointer was left sitting near/inside the EGM block from the earlier
interrupt, and resuming there re-entered EGM setup without going through `RunEgmJoint`'s own
`EGMReset` (which only runs when execution starts fresh from `main()`). Result: RAPID error
**"You have to disconnect an EGM instance using EGMReset before you can connect another"**,
immediate `Execution error state`, task stopped again. **Recovery**: `stop` → `resetpp` →
`start`. Rule of thumb: after any *external* stop while using `gofa-egm`, always `resetpp`
before the next `start` — not needed for `gofa-egm`'s own `start`/`stop` cycle anymore, since
that no longer stops the task.

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

**`gofa-egm` (Node.js side, session control + telemetry only)**: `nodes/gofa-egm.js`. Hand-rolled
proto2 codec (`decodeEgmRobot`/`encodeEgmSensor`, exported for `test.js`) — no protobufjs
dependency. As of 2.2.3, the package has **zero runtime dependencies**: the `ws` package was
replaced with a hand-rolled WebSocket client (`nodes/lib/ws.js`, used by `gofa-subscribe-elog`/
`-io`/`-state`) built on Node's own `http`/`https`/`crypto`, same pattern as this EGM codec.
Verified **byte-for-byte** against
reference bytes generated by the proven `gofa-egm-python` project's `egm_pb2` (compiled from
ABB's own `proto/egm.proto`), not just self-consistency — see the codec tests in `test.js`. Uses
Node's built-in `dgram`, lifecycle modeled on `gofa-subscribe-io.js` (`_stopped` flag, status
color convention, teardown on `node.on('close')`). Has an **Action** config dropdown
(`start`/`stop`, default `start`) overridable by a bare `msg.payload` string or
`msg.payload.action` — same pattern as `gofa-motor`/`gofa-rapid-exec`, so a bare inject just
runs whichever action the node instance is configured for; put one instance per action in a flow
(see the demo flow). On `start`: sends `EGMJOINT`; `ERR:EGMJOINT` means `MainModule.mod` (wrong
module) is loaded — surfaced as a specific error, not a hang; binds UDP and waits up to 2s for
the first frame (timeout → check `EGM_PC` config / firewall). Holds the current pose (echoes
feedback back unchanged) until a `gofa-egm-move` node sets a `[j1..j6]` target — never moves on
connect. Output throttled (`throttleMs`, default 100ms) since real EGM frames arrive every
~24ms, far faster than most flows need. On `stop` (and on `close` if a session was active): sets
`ABB_Scalable_IO_0_DO16` via RWS to trigger the TRAP/`EGMStop` graceful exit described above,
then polls `PING` (up to 8s) until TCP serving resumes as confirmation — see the mode-exit fix.

**Session state lives on the shared `gofa-robot` config node, not on the `gofa-egm` node
instance** (`robot._egmActive`/`robot._egmTarget`/`robot._egmBaseline`) — same
cross-node-coordination pattern already used by `_seqStop`/`_seqRunning` (`gofa-stop-seq`
writes, `gofa-sequencer` reads). `gofa-egm` owns the UDP socket and the receive loop (decode →
echo `robot._egmTarget` back → throttled telemetry emit) and sets `robot._egmActive`/
`robot._egmBaseline`; **`gofa-egm-move`** (`nodes/gofa-egm-move.js`, a separate node) is the only
thing that writes `robot._egmTarget` — it takes a `[j1..j6]` array (or `{joints:[...]}`,
normalized to a bare array on output) via input, and checks `robot._egmActive`: if a session is
running, updates the target and sends out **output 1**; if not, sends the same message
unchanged out **output 2** (fallback) instead of erroring — wire output 2 into `gofa-movej` for
an automatic non-EGM fallback (payload shapes are directly compatible, confirmed by reading
`gofa-movej.js`'s input handling — no `change` node needed). This also fixes a latent bug from
before the split: two `gofa-egm` node instances on the same robot used to track independent
session state despite the controller only ever supporting one real EGM session.

**Confirmed live end-to-end, 2026-07-09** (GoFa 12 / OmniCore C30, RobotWare 7.21.0+229):
`gofa-egm` `start` → baseline hold (no motion) → a `+3°` target on joint 6 → real, visible
motion, telemetry converging smoothly from baseline through the full ramp to the new target
→ target set back to baseline → smooth return → `stop` → `PING` confirms TCP mode restored,
repeatably. Also confirmed: `start` while RAPID is stopped fails in ~5s with a clear error, not
a hang; a simulated mid-session Node-RED redeploy (`close()` while streaming) recovers the
robot cleanly. **Also confirmed (same day, later session) with the TRAP/`EGMStop` fix in
place**: 12 consecutive start/stop cycles, ~80ms per `start` and ~1.05s per `stop` with zero
timing drift across all 12, zero errors, zero "Too many EGM instances" — and zero
"Program stopped"/"Program started" elog events for the whole run, proving the task genuinely
never stops on a normal `gofa-egm` cycle anymore.

**Node split (2026-07-09, later session): confirmed live.** Drove the actual `gofa-egm`/
`gofa-egm-move`/`gofa-movej` node files (not a reimplementation) against the live robot via a
small script instantiating the real Node-RED modules with a minimal fake-RED harness. Full
cycle confirmed: `gofa-egm` `start` (bare inject, configured Action) → session active
(`robot._egmActive === true`) → `gofa-egm-move` `+3°` target on joint 6 → output 1 fires,
telemetry shows real convergence (124.47° → 127.46°) → target set back to baseline → telemetry
converges back → `gofa-egm` `stop` (bare inject) → `robot._egmActive === false`, `PING` confirms
TCP mode restored. **Fallback path confirmed working end-to-end**, not just on paper: with EGM
inactive, `gofa-egm-move` routed to **output 2**; feeding that message into a real `gofa-movej`
node produced genuine `MOVEJ` TCP commands with `{ok:true, joints:[...]}` replies, moving the
robot to the target and back via the normal path. Also confirmed live: a bare joint-array
payload sent to `gofa-egm` no longer triggers movement (old contract genuinely removed — it just
falls through to the node's configured Action), and `{action:'bogus'}` is rejected with the
expected error.

**EGM Node Hazard Fixed (2026-07-10)**: after `stop()` completes, `robot._egmTarget` was previously left non-null (a stray in-flight UDP frame arriving during the ~1s graceful-stop window re-triggered `onFrame`'s "first frame of session" baseline-capture logic, since `robot._egmBaseline` was just nulled by `stopAll()`) instead of staying `null`. Fixed by returning early in `onFrame` if `!node.robot || !node.robot._egmActive || !node.robot._egmSocket`, which prevents late UDP frames from re-populating baseline/target or attempting to send on the nulled socket. Added a test confirming this behavior.

**Bug found and fixed post-publish (2026-07-09, follow-up session): the UDP socket wasn't
actually shared, only the flags were.** User hit `gofa-egm: bind EADDRINUSE 0.0.0.0:6510` on a
second "Start EGM" — root cause traced live: the socket-sharing refactor above moved
`_egmActive`/`_egmTarget`/`_egmBaseline` onto `robot`, but `node._socket` (the actual dgram
socket) was left as node-instance-local state. With the documented two-instance pattern (a
"Start EGM" node and a separate "Stop EGM" node, same as `gofa-motor`'s Motors ON/OFF), the Stop
instance's `stopAll()` closed *its own* `node._socket` (always `null`, since that instance never
binds one) instead of the Start instance's real socket — leaking the UDP port until that
specific Start instance got redeployed. Confirmed live: `netstat` showed the port held by a
stray `node.exe`; killing it and retrying still would have hit the same leak on the next
Start/Stop cycle without a real fix. **Fix**: moved the socket itself onto `robot._egmSocket`
too (`gofa-robot.js`'s constructor, alongside the other `_egm*` fields) — any `gofa-egm`
instance's `stopAll()` now closes whichever socket is actually open, regardless of which
instance created it. `bindSocket()` also defensively closes any stale `robot._egmSocket` before
creating a new one, so a leaked reference can't cause `EADDRINUSE` again even in edge cases.
**Also fixed a related orphaning gap surfaced by the same incident**: if `EGMJOINT` succeeds
(controller enters EGM mode, closes its TCP server) but the local UDP bind then fails for any
reason (this `EADDRINUSE`, or a genuine "no frames within 2s"), the controller-side session was
being abandoned with no natural recovery (same `\CommTimeout`-doesn't-help finding as everywhere
else in this doc) — `start()` now sends the graceful-stop signal as best-effort cleanup in that
specific case (EGMJOINT acked, something after it failed), so a failed Start doesn't leave the
robot silently stuck. **Confirmed live**: reproduced the exact reported scenario (Start on
instance A → Stop on a *different* instance B → Start on A again) end-to-end via the real node
files — no `EADDRINUSE`, port cleanly released between cycles, robot healthy throughout. 142/142
unit tests pass, including two new ones for this (`gofa-egm: a DIFFERENT node instance can close
the socket a Start instance opened`, `gofa-egm: start() releases the orphaned controller-side
session if EGMJOINT acked but the UDP bind fails`).

**Prerequisites (one-time, not automatable from Node-RED)**: a UDP Unicast Device named
`EGM_PC` (RobotStudio → Controller → Configuration → Communication → UDP Unicast Device →
right-click → New UDP Unicast Device...; Remote Address = the Node-RED host's IP on the
robot's subnet, Remote Port Number = `gofa-egm`'s configured UDP port (default 6510), Local
Port Number = 0; needs a controller restart), and a firewall rule on the Node-RED host allowing
inbound UDP on that port. **The Remote Address drifts the
same way the robot's own IP does** (see the robot-IP-drift note elsewhere in this doc) —
confirmed live: `start` bound UDP fine and got `OK:EGMJOINT`, but zero frames ever arrived and
RAPID hung indefinitely (see the mode-exit correction — nothing timed out on its own), because
`EGM_PC`'s Remote Address was stale from a prior session's dev-PC IP. Symptom is exactly "no
EGM frames received within 2s" from `gofa-egm` despite the module/mastership/firewall all being
correct — check `EGM_PC`'s configured Remote Address against the Node-RED host's *current* IP
before assuming anything else is wrong.

**`EGM_PC`'s config is readable over RWS (confirmed live, 2026-07-17) — `GET
/rw/cfg/SIO/UDPUC_HOST/instances/EGM_PC`** (domain `SIO`, type `UDPUC_HOST` — found by listing
`GET /rw/cfg/<domain>` for all six domains this controller exposes: `EIO`, `MMC`, `MOC`, `PROC`,
`SIO`, `SYS`). Returns `RemoteAddress`/`RemotePortNumber`/`LocalPortNumber` directly, so the
Remote-Address-drift check above no longer needs RobotStudio open — just diff it against the
Node-RED host's current IP. **Writing it over RWS was not solved**: `OPTIONS` reports `Allow:
GET,POST,DELETE,OPTIONS` (POST looks valid) but a plain form-encoded `POST
.../instances/EGM_PC` body (`RemoteAddress=<ip>`, both plain and `hal+json` Accept) gets a clean
`400 "Error incorrect value representation"` — a different failure shape than the
`loadmod`/`CAB_TASKS` "wrong URL, Allow lies" cases elsewhere in this doc (this one has zero
side effects and looks like a body-encoding mismatch, not a dead endpoint), but not chased
further since blind trial-and-error against a network-config write on a live controller wasn't
worth the risk for a one-time setting. **RobotStudio remains the way to change it.**

**Caution — a config change in the wrong domain silently doesn't fix `EGM_PC` and can revert
other things.** Live incident (2026-07-17): a user-made config change intended to fix
`EGM_PC`'s stale Remote Address actually landed in the **`EIO`** domain (confirmed via the
elog: `"Configuration parameter changed... domain: EIO"`), not `SIO` — `EGM_PC` was still stale
after a restart, **and** `ABB_Scalable_IO_0_DO16`'s (the EGM graceful-stop signal, see below)
Access Level reverted from `All` to `Default` as a side effect, breaking `gofa-egm`'s RWS write
to it (`403 Rejected`) on the next `stop`. Confirm which domain a config change actually lands
in (the elog says so) before assuming a fix took effect, and re-check signal Access Levels after
any `EIO`-domain change, not just after a full backup/restore.

**`gofa-egm`'s `stop()` now falls back to the background-task transport if the RWS write to the
graceful-stop signal (`ABB_Scalable_IO_0_DO16`) is rejected** (`setStopSignal()` in
`gofa-egm.js`, added 2026-07-17 after hitting the incident above live) — RAPID always has I/O
write access regardless of RWS Access Level (same reasoning as `gofa-do-write`'s Background
transport), so `robot.socketSend({cmd:'setdo', name, val}, robot.backgroundPort)` is a reliable
fallback whenever the direct RWS `POST .../set-value` 403s. Without this, an Access-Level
regression like the one above leaves an active EGM session permanently stuck mid-`EGMRunJoint`
with literally no way to trigger the graceful-stop TRAP — confirmed live: it took a manual,
out-of-band `setdo` over the background port to recover from exactly this, before the fallback
existed in code. **Confirmed live end-to-end after the fix**: full `gofa-egm` `start` → `+3°`
nudge on joint 6 (telemetry confirmed real convergence, `6.40°` target reached) → back to
baseline (converged again) → `stop` (succeeded via the code path, no manual intervention) —
physical motion and the ASI LED (magenta while streaming, green after stop, via
`BackgroundLed.mod`) both independently confirmed by a human watching the robot.

**Tool load data caution — ADDRESSED 2026-07-21 for the current no-tool state; still open for
whenever a real gripper is mounted.** ABB's EGM Application Manual states the robot must have
correct tool load data (`LoadIdentify`) before starting EGM — incorrect load data can cause
servo torque overruns or safety halts when EGM issues fast corrections. `LoadIdentify` itself
can't be run with nothing physically mounted (it works by moving the robot through
characterization moves and reading back motor torque/current to solve for the mass/CoG/inertia
of whatever's actually attached — there's nothing to measure on a bare flange). What *was*
fixable now: `MainModule.mod`/`MainModuleEGM.mod` both used the placeholder `tGripper` tooldata
(`[0,0,100]` TCP offset, 1kg mass) as the active tool for **every** motion instruction, not just
EGM — confirmed by grepping both files, ~20 call sites each (`MoveJ`/`MoveL`/`MoveAbsJ`/`CRobT`/
`CalcRobT`). That's a real mismatch, not just an EGM-specific safety gap: `gofa-pose`/
`gofa-save-point`/`gofa-subscribe-pose` all read position via RWS `tool=tool0&wobj=wobj0`
(unrelated to RAPID's active tool), so a point saved via those nodes and replayed via `GOTOJ`/
`MOVEJ` would land ~100mm off from where it was captured — `tGripper`'s TCP offset applied on
replay but not on the original read. Both `.mod` files now target RAPID's built-in `tool0`
(empty flange, zero mass) for all motion instead; `tGripper` stays declared, unused, as a
placeholder — see the `ponytail:` comment above its declaration in both files. **Upgrade path**:
once a real gripper is mounted, run `LoadIdentify` (or otherwise measure the real mass/CoG/
inertia/TCP offset), populate `tGripper`'s literal values, and switch the tool argument on every
motion instruction in both files back from `tool0` to `tGripper`.

**Deployed and confirmed live, 2026-07-21**: the controller was running `MainModuleEGM.mod`
(not the plain `MainModule.mod`), so that's the one pushed via `gofa-setup`'s own upload → unload
sibling → load → resetpp → motors on → start → PING sequence (driven against the real robot,
same fake-RED-harness pattern used elsewhere in this project for standalone live tests).
Verified by reading the module text back off the controller afterward (`GET .../modules/
MainModuleEGM/text` → `file-path` → `GET /fileservice/<path>`): 0 `tGripper` tool-argument uses,
19 `tool0` uses, placeholder comment present. `check-status.js` confirmed RAPID `running`,
motors `motoron`, socket healthy post-deploy. `MODULE_VERSION` bumped to 2.4.5 in all three
`.mod` files (kept in lockstep with `package.json`, same convention as the 2.4.2 bump above,
even though `BackgroundLed.mod`'s own content didn't change) and redeployed live so the
controller's `ping` reply matches.

Full design history and the reasoning behind the two-module decision: see the
`project_egm_node_red_integration_plan` memory and its linked plan file.

## Background LED task (`BackgroundLed.mod`, added 2026-07-17)

**Problem this solves**: `flows/teach_workflow_flow.json`'s teach workflow stops the whole
`T_ROB1` task (`POST /rw/rapid/execution/stop`) before enabling lead-through — hand-guiding
requires the motion task fully stopped, not just motion cleared. That kills
`MainModule.mod`'s socket server along with it (it's part of `T_ROB1`'s own `main()` loop), so
`gofa-asi-led`'s Socket transport (`SETLED`/`RESETLED`) times out for the whole teach session.
The RWS transport (`/set-value`, added earlier the same day) doesn't help either — the ASI
board is the robot's built-in collaborative-status/safety light, and on this controller its
signals don't expose an editable `Access Level` at all (confirmed live: RobotStudio only lets
you change Access Level on the DSQC1030 Scalable I/O board, not the ASI signals), unlike a
regular I/O add-on.

**Fix**: `rapid/BackgroundLed.mod` is a small, standalone RAPID module — its own copies of the
JSON-parsing helpers, not shared with `MainModule.mod` (RAPID modules in different tasks can't
call each other's local PROCs directly) — that only serves `ping`/`setled`/`resetled`/`setdo`
over its own TCP port (`LED_SERVER_PORT := 1026`, matches `gofa-robot`'s `backgroundPort` config
field, default 1026 — renamed from `ledPort` once this task started serving more than LED
commands). It's meant to run in a **separate RAPID task**, not `T_ROB1` — the whole point
is that stopping `T_ROB1` doesn't touch it. This relies on RobotWare Multitasking `[3114-1]`,
confirmed genuinely licensed on this controller (`GET /rw/system`, see the `omnicore-c30`
skill) — up to 20 concurrent tasks, ABB's own stated use case for it is exactly this
("supervising signals or driving peripheral equipment in parallel with robot motion").

**Generalized to a background-services task (2026-07-17), per
`ideas/background-services-task-plan.md`.** Beyond LED feedback, this same mechanism fixes
anything else that depends on `T_ROB1`'s socket and breaks whenever it's stopped:
- `setdo` was added to `BackgroundLed.mod`'s `DispatchJson`, copying `MainModule.mod`'s
  `TrySetDo`/`setdo` allow-list/case-sensitivity pattern verbatim (digital I/O is
  global/task-independent by RAPID's I/O architecture, unlike PERS variables — see below).
  `gofa-do-write` gained a third **Background task** transport option alongside RWS/Socket,
  using the exact same `socketSend({cmd:'setdo', name: signal.toUpperCase(), val}, robot.backgroundPort)`
  pattern `gofa-asi-led`'s Background transport already established.
- `gofa-connection-status` now pings `robot.backgroundPort` as a third, independent check
  (`msg.payload.background`) — since that task survives `T_ROB1` being stopped, comparing
  `socket.ok` (T_ROB1) against `background.ok` distinguishes "T_ROB1 specifically
  wedged/stopped" from "whole controller unreachable" — the diagnostic value
  `ideas/improvement-roadmap.md`'s watchdog idea wanted, for near-zero new code since the hard
  part (a task that survives `T_ROB1` issues) was already built and live-verified for LED.
- `gofa-egm` now sets the ASI LED to a distinct color (magenta) via the Background transport
  while an EGM session is streaming (same root cause: EGM also closes `T_ROB1`'s TCP serving
  for the session's duration) and resets it to green on `stop` — best-effort only, a LED write
  failure never blocks/fails an EGM start or stop.
- **Explicitly out of scope**: PERS variable read/write (`gofa-rapid-var-read`/`write`) via the
  background task — whether a PERS variable declared in `MainModule.mod` (`T_ROB1`) is visible
  to code in a different task (`T_LED`), or whether each task gets its own independent copy,
  isn't confirmed and needs its own live test before a design can be committed to. Digital I/O
  doesn't have this problem (already proven via `SetGO` on the ASI signals working identically
  from `T_LED`).
- **Reload procedure — confirmed live end-to-end, 2026-07-17.** Unlike `T_ROB1`, `T_LED` is
  `SEMISTATIC` and confirmed **not** stopped by `POST /rw/rapid/execution/stop`, so there's no
  RWS call to stop it before `loadmod` (which requires the target task stopped). The actual
  working procedure, found live (RobotStudio's RAPID-tab Debug-group task selector turned out
  not to be the way — the real control is FlexPendant-side):
  1. **Controller must be in Manual mode** — the setting below is hidden/blocked in Auto.
  2. FlexPendant → **Execution menu** → check **"Handle static and semi-static tasks the same
     way as normal task regarding start/stop."** This is what actually makes a semistatic task
     stoppable at all — with it off, there is no path (RWS, RobotStudio, or FlexPendant) found
     to stop `T_LED` short of a full controller restart.
  3. Press **Stop** — now stops `T_ROB1` *and* `T_LED` together. Confirmed via `GET
     /rw/rapid/tasks/T_LED` → `excstate: stopped`.
  4. **RWS `loadmod` is still blocked here** — `POST /rw/mastership/edit/request` fails `403
     "Requested resource is held by someone else"` once the FlexPendant is actively driving the
     controller (`GET /rw/mastership/edit` shows `location: FlexPendant device`, `application:
     TPU` holding it locally) and separately, edit mastership over RWS was found to need Auto
     mode, which un-does the stop (see step 6). **Load the module directly on the FlexPendant
     instead**: ABB menu → Program Editor → task selector (top) → switch to `T_LED` → File →
     Load Module... → `$HOME/Programs/BackgroundLed.mod` (upload it first via `gofa-file`/RWS
     `fileservice PUT` same as always — only the *load-into-task* step needs the FlexPendant,
     not the file transfer) → confirm **Replace** (same module name already loaded).
  5. Verified the reload actually took by reading the loaded module back over RWS — `GET
     /rw/rapid/tasks/T_LED/modules/BackgroundLed/text` returns a fileservice reference
     (`file-path`), not the text itself (same indirection as the module-text fallback noted
     elsewhere in this doc); a follow-up `GET` on that path returned the new source byte-for-byte,
     confirmed against the repo copy.
  6. Restart both tasks (Start on the FlexPendant, or a normal `gofa-rapid-exec` `start` once
     back in Auto — both tasks came back together). Then **uncheck the Execution-menu setting
     from step 2 again** — leaving it on means every future ordinary RAPID stop (including the
     teach workflow's) also stops `T_LED`, defeating the entire reason this task exists.
  7. Live-verified after reload, both directly over the socket and through the real
     `gofa-do-write` node file: `setdo` on `ABB_SCALABLE_IO_0_DO1` via the background port
     flips `0→1→0`, independently cross-checked with an RWS `lvalue` read after each step.

**Confirmed live (2026-07-17): RWS cannot create a new task, only RobotStudio can.**
`GET /rw/cfg/sys/CAB_TASKS/instances/T_ROB1` exposes the full task config schema (17
attributes — `Name`, `Type` (init `SEMISTATIC`), `Entry` (init `main`), `TrustLevel`,
`MotionTask`, `Hidden`, RMQ settings, etc., **none marked mandatory**), and `OPTIONS` on both
`/rw/cfg/sys/CAB_TASKS/instances` and an existing named instance both report `Allow:
GET,POST,DELETE,OPTIONS` — looked exactly like the kind of case this project has cracked
before (Allow header technically correct, just needs the right URL shape/Accept header, per the
`loadmod`/`/set-value` precedents). Tried four variants against the live controller, all
`405 HTTP method not supported by resource` with zero side effects each time (confirmed via
instance count staying at 3 throughout): plain `POST .../instances` with `Name=T_LED&Entry=main`;
same with `Accept: application/hal+json;v=2.0`; `POST .../instances?action=add`; and
`POST .../CAB_TASKS?action=create-instance` (type-level). Unlike the `loadmod`/backup cases,
**no variant worked** — this reads as a genuine, structural "RWS can create/modify existing
instances but not add new ones" limitation (task creation needs stack allocation and boot-time
registration RWS isn't built to hot-provision), not a wrong-URL red herring. **Don't re-attempt
this without a new, concrete reason to believe it's changed** (a RobotWare update, or new
official documentation) — this was tested thoroughly, not assumed.

**CONFIRMED LIVE (2026-07-17) — the core premise holds.** Stopped `T_ROB1` via
`POST /rw/rapid/execution/stop` (the exact call `gofa-rapid-exec`'s `stop` action and the teach
workflow's "Stop RAPID" step use — no motion involved) and polled `GET /rw/rapid/tasks`
immediately after. Result: `T_ROB1` (`type: normal`) → `excstate: stopped`, while the
controller's own **pre-existing** `SC_CBC` and `T_GOFA_LED` tasks (both `type: semistatic`)
stayed `excstate: started` throughout, unaffected. `T_ROB1` was restarted afterward (motors on
+ `regain=continue` start) and confirmed back to `running` with a clean socket `PING`. This is
the exact mechanism the whole design depends on, and it's real, not inferred.

**Bonus discovery from that same check: this controller already has a task named
`T_GOFA_LED`.** `GET /rw/rapid/tasks/T_GOFA_LED/modules` shows it runs `GOFA_Main` (`SysMod`) —
almost certainly ABB's own built-in driver for the collaborative-robot status light (explains
why the ASI board's `Access Level` isn't user-editable: it's a protected/safety-tied signal ABB
firmware already owns). Confirmed it's genuinely off-limits, not just cosmetically locked:
`GET /rw/rapid/tasks/T_GOFA_LED/modules/GOFA_Main/text` → `500 "Module encoded, noview or
readonly"`. **Do not attempt to read, edit, or repurpose `T_GOFA_LED`/`GOFA_Main`** — it's
ABB's own protected code, encoded and inaccessible by design; `BackgroundLed.mod` must run in
its *own*, separate new task, never this one.

**Tried and confirmed NOT possible: creating that new task via RWS instead of RobotStudio** (see
the box below) — a real, thorough attempt, not a guess. RobotStudio remains required for this
one step.

**`BackgroundLed.mod` is already uploaded to the controller** (`$HOME/Programs/BackgroundLed.mod`,
via the real `gofa-robot.js`/`patchServerIp` code path, `SERVER_IP` confirmed correctly patched
to `192.168.1.103`, verified with a follow-up `GET` round-trip) — the remaining setup step below
is RobotStudio-side only, no re-upload needed.

**One-time RobotStudio setup (confirmed required — RWS cannot create tasks):**
1. ~~Upload `BackgroundLed.mod`~~ — already done, see above. (If it ever needs re-uploading —
   e.g. after an edit — use `gofa-file`'s upload action or RobotStudio; same `SERVER_IP`
   auto-patch mechanism as `MainModule.mod`.)
2. RobotStudio → **Controller** tab → **Configuration** → **Controller** topic → **Task** →
   add a new task instance, name `T_LED`.
3. Set **Type** to `SEMISTATIC` (starts automatically at power-up, resets to the top of `main()`
   each restart, and — per ABB's task-type model, now empirically confirmed above — is *not*
   part of the FlexPendant/RWS Program Start/Stop cycle the way a `NORMAL` task like `T_ROB1`
   is). `STATIC` would also work (same independence from Program Stop) but doesn't auto-reset
   the program pointer on restart.
4. **Set `TrustLevel` to the least-severe option available, NOT the field's own default
   (`SysFail`).** Confirmed live via `GET /rw/cfg/sys/CAB_TASKS/attributes`: a brand-new task
   instance defaults to the *same* `TrustLevel` as `T_ROB1`'s real motion task — meaning an
   unhandled RAPID error in this little LED-blinking utility task would, left at default, be
   treated as severely as a fault in the motion task itself (`SysFail` — full system failure).
   There's no reason a cosmetic feedback task should carry that blast radius. Supporting
   evidence: `GET /rw/rapid/tasks/T_GOFA_LED` (the controller's own built-in LED task) reports
   `trust="None"` at runtime — ABB's own equivalent task uses the least-severe level, not
   `SysFail`. Couldn't confirm the exact raw config string this maps to, though — `T_GOFA_LED`'s
   own `CAB_TASKS` config instance is itself `rdonly: true` with its attribute list hidden
   (consistent with `GOFA_Main` being "encoded, noview" — see below), so the mapping from
   RobotStudio's Task-config `TrustLevel` dropdown labels to this runtime `trust` string wasn't
   directly verifiable. In RobotStudio's own Task Type dialog, pick whichever option is labeled
   as no/least safety-propagation (commonly `NoSafety`, sometimes `SysStop` if that's not
   offered) — anything less severe than the `SysFail` default is the point.
5. Assign `BackgroundLed.mod` to this task (**not** `T_ROB1` — loading it there would collide
   with `MainModule.mod`'s own `PROC main()`, same ambiguity as the `MainModule`/`MainModuleEGM`
   case documented in the EGM section above).
6. Restart the controller.

**CONFIRMED LIVE END-TO-END (2026-07-17), including physical visual verification — the whole
feature works.** `T_LED` created and set up per the steps above (RD2 did this live); after the
controller restart, `T_LED` shows `excstate: started` and `BackgroundLed.mod` compiled cleanly
on the first try (no RAPID syntax errors). Full sequence tested against the real robot:
1. `ping` on port 1026 → `OK:PING`, confirming the module's socket server is actually up.
2. `setled` (cyan, then white, then cyan again) while `T_ROB1` was genuinely stopped the whole
   time → every call `OK:SETLED`, and a plain RWS read of `Asi1LedGreen` independently confirmed
   the hardware value actually changed (not just a fake ack).
3. **Physical confirmation, not just API/signal-level**: set the LED to bright red via `T_LED`
   and polled `Asi1LedRed/Green/Blue` every 300ms for 6 seconds — the signal held steady the
   whole time (ruling out `T_GOFA_LED` fighting for control), and RD2 confirmed the physical
   light genuinely went solid red, then back to solid green after `resetled` — a clean, visible
   change, not a flicker or a no-op.
4. Full realistic cycle — stop `T_ROB1` → LED cyan → LED white flash → LED cyan → restart
   `T_ROB1` → LED reset to green — ran start to finish with `T_ROB1` ending back in `running`
   and a clean socket `PING` on port 1025 too. Both tasks healthy simultaneously.

An earlier "LED stuck at solid green, no color change" report during this same session turned
out to be a false alarm — the automated test script cycled through colors and reset back to
green within a couple of seconds with no pause, so by the time the color was checked visually,
`resetled` had already fired. Slowing down and checking mid-sequence confirmed every color
change was real. Worth remembering if this is ever debugged again: confirm timing/pauses before
assuming the mechanism itself is broken.

**Also confirmed against the real, deployed `teach_workflow_flow.json`** (not just raw scripts
driving `gofa-robot.js` directly) — ran Node-RED locally with the flow imported and the actual
physical ASI buttons pressed live: Button 1 → stop RAPID → enable lead-through → (see LED
priority note below) → Button 2 pressed twice, two real poses captured (`gofa-save-point`
correctly wrote both to `points.json`) → Button 1 again → disable lead-through → resetpp →
restart RAPID, ending back in `running` with motors on. Full realistic cycle, not a simulation.

**ABB's own safety controller drives the physical LED through several states that override
whatever `gofa-asi-led` sets, and this is correct, desirable behavior — not something to
"fix."** Confirmed live, in order, on a single lead-through cycle:
- **White**, ~3 seconds, immediately on enabling lead-through — a transition/negotiation
  indicator while the safety controller activates hand-guiding mode. `waitForLeadThroughState`
  in `gofa-leadthrough.js` can report RWS status `Active` slightly before this physical
  transition fully settles, so the LED doesn't switch to whatever custom color was just set
  until a few seconds after the flow believes lead-through is active.
- **Yellow**, immediately and only while the robot is *actually moving* — confirmed by moving
  the arm under hand-guiding and watching the color change in real time. This overrides any
  custom color instantly, and reverts the instant motion stops (confirmed the underlying
  `Asi1LedRed/Green/Blue` GO signal values held steady and unchanged throughout — the override
  happens at the physical-hardware level, not by rewriting the signals, so a `setled`/`SetGO`
  call always "succeeds" per its ack even while yellow is showing).
- Our own custom color (yellow, yellow-flash, green — see the color-choice note below) — only visible during genuinely idle,
  stationary moments, once the above two are not asserting.

**Correction, 2026-07-20 — most of that "white ~3 seconds" delay was never the safety
controller's negotiation at all; it was a real, fixable bug in `gofa-leadthrough.js` wasting a
full 5-second socket timeout on every `enable` call.** `enable`'s first step sends a socket
`{cmd:'stop'}` to clear queued `\Conc` moves before activating lead-through — necessary if RAPID
is genuinely running, but this palette's own teach flow (and presumably most real usage) always
stops RAPID *first*, so by the time `enable` runs, T_ROB1's socket server is already down (it's
part of RAPID's own `main()` loop) and that call is guaranteed to fail, just not until the full
`sock.setTimeout(5000)` in `gofa-robot.js` elapses. Instrumented live: **6324ms** total for
`enable` to resolve, of which **5003ms** was purely this doomed socket call timing out, and only
~1300ms was the genuine RWS `POST` + `waitForLeadThroughState` poll. Confirmed this wasn't a
polling artifact either — a completely unchained, isolated color write held perfectly steady for
3+ seconds with zero interference from any other task, ruling out `T_GOFA_LED`/`GOFA_Main`
fighting for control at this stage. **Fixed**: a new `clearQueuedMovesIfRunning(robot)` helper
(shared by the runtime node and the `/toggle` admin endpoint) checks `/rw/rapid/execution`'s
`ctrlexecstate` first (a single fast RWS `GET`, ~10ms) and skips the socket-stop attempt
entirely when it's already `'stopped'` — nothing queued to clear. If the execstate check itself
fails, it falls back to attempting the clear (the pre-optimization behavior), so the safety
property this step exists for is unchanged for the case it actually protects (RAPID genuinely
running). Confirmed live end-to-end: `enable` against the real robot with RAPID stopped now
resolves in **44ms**, down from 6324ms. This means the *remaining* white period during a real
lead-through activation (RAPID running → enable, the one case this fix doesn't shortcut) is
still expected and is the actual safety-controller negotiation described above — just no longer
compounded by ~5 seconds of unrelated wasted timeout in the normal stop-then-enable sequence.

**Practical takeaway for the teach workflow's LED design**: don't design around forcing a custom
idle color to be continuously visible throughout an active lead-through session — it won't be,
and shouldn't be, since yellow-while-moving is a real safety signal that must take priority.
Treat whatever color the flow sets as an "idle within the teach session" indicator only. The
"point saved" flash (Button 2) works reliably because a point save naturally happens while the
arm is stationary (the user pauses hand-guiding to press the button) — confirmed live, twice, no
interference from the white/yellow override states above.

**Idle color changed from cyan to yellow, 2026-07-20, by request — and the point-saved flash
changed from white to yellow the same day, also by request.** `teach_workflow_flow.json`'s "LED:
Teach Mode ON" and "LED: Restore Teach Idle" (after a point save) both now set solid yellow
(255,255,0) instead of cyan, and "LED: Point Saved" now flashes yellow (255,255,0) twice instead
of white — the same color the safety controller's own motion override uses. This is a deliberate
choice: since yellow-while-moving always wins anyway, using yellow as the idle/flash color too
means the LED no longer visibly changes color between "idle," "point saved," and "moving" states
during a teach session — one consistent color throughout instead of a cyan/white/yellow mix.
"LED: Teach Mode OFF" still resets to green (0,255,0), matching the normal RAPID-running state
elsewhere in this palette.

**Node-RED side**: `gofa-robot`'s `socketSend(cmd, port)` now takes an optional port override
(previously always used the configured `socketPort`) — confirmed live end-to-end today with a
throwaway TCP server (not just unit-mocked) and against the real `T_LED` port. `gofa-asi-led`
gained a third Transport option, `'background'`, that calls `socketSend(cmd, robot.backgroundPort)`
instead of the default port. `teach_workflow_flow.json`'s three LED nodes (Teach Mode ON/OFF,
Point Saved) are wired to `transport: 'background'` and now confirmed working for real.
`gofa-do-write` gained the same `'background'` transport option later (2026-07-17) — see the
"Generalized to a background-services task" note above.

## Module version handshake + watchdog flow (added 2026-07-20)

**Problem this solves**: the palette (npm package) and whichever `.mod` file is actually loaded
on the controller are two halves of one protocol that can silently drift — the npm package gets
updated but nobody re-runs `gofa-setup`/re-uploads the module, and some new feature then fails
with a confusing, unrelated-looking error instead of "you're running a stale module." This was
item #1 on `ideas/improvement-roadmap.md`. Separately, item #2 on that list (a self-healing
watchdog for the still-unexplained socket-wedge bug — `project_socket_server_stuck_2026-07-15`
memory) needed the connectivity-diagnostic groundwork `gofa-connection-status`'s `background`
field already provided (2026-07-17) but never got the actual recovery *flow* built. Both shipped
together this session since the watchdog's "did recovery work" check is the same connection
check the version handshake extends.

**Version handshake mechanism**: `MainModule.mod`, `MainModuleEGM.mod`, and `BackgroundLed.mod`
each declare their own `CONST string MODULE_VERSION` (kept in lockstep with this package's
`package.json` "version" — bump both together on any socket-protocol change) and now include it
in their `ping` JSON reply: `{"status":"ok","cmd":"ping","version":"2.4.0"}`. On the Node.js
side, `createRobotClient()`'s `socketSend()` records the reported version per-port as a side
effect of every successful ping (`getLastPingVersion(port)` on both the raw client and
`GoFaRobotNode`; omit `port` for the main T_ROB1 socket, pass `robot.backgroundPort` for
`BackgroundLed.mod`'s independent version) — `null` if no ping has succeeded yet on that port, or
if the module that replied predates this feature (no `version` field at all, not an error).
`require('./gofa-robot').PALETTE_VERSION` is the single source of truth for the "expected"
version, read live from `package.json` rather than duplicated as a second constant.

`gofa-connection-status` surfaces this as `msg.payload.moduleVersion.{socket,background}` —
each `{version, status}` where `status` is `'match'` / `'mismatch'` / `'unknown'` (ping failed,
or module too old to report a version) — plus `.expected`. A `mismatch` on an otherwise-healthy
result sets yellow status (`'ok, module vX mismatch (expected vY)'`) instead of green, without
affecting `payload.ok` itself.

**The runtime comparison is major.minor only, not exact (added 2.4.11).** `versionsCompatible(a, b)`
in `gofa-robot.js` (exported, used by both `gofa-connection-status` and `gofa-setup`) treats two
versions as a `match` when their `major.minor` agree — a module left at `2.4.9` against a `2.4.10`
palette reports `match`, not `mismatch`. Rationale: patch releases never change the socket protocol
(they're bumped in lockstep purely for provenance), so a patch skew doesn't warrant nagging the
user to re-flash; only a **major/minor** bump signals a real protocol change worth flagging. This
is deliberately looser than the `test.js` lockstep check, which still asserts the shipped module's
`MODULE_VERSION` string equals `package.json` **exactly** — that's repo hygiene (a freshly-shipped
module must report the current version), a separate concern from how tolerant the *runtime* health
check is. Net effect: `MODULE_VERSION` is still bumped on every release, but users no longer see a
false `mismatch` warning after a patch upgrade they haven't re-flashed for. `gofa-setup`'s final `socket PING` step folds the same comparison
into that step's `detail` string (`'OK (module vX.Y.Z)'`, or a `WARNING` detail naming both
versions and pointing at the `rapid/` sync rule elsewhere in this doc, or an "unknown" detail for
a pre-handshake module) — informational only, never fails the step, since setup genuinely did
succeed either way.

**Confirmed live end-to-end (2026-07-20)**, driving the real node files (not curl, not a
reimplementation) via the same fake-RED harness pattern `test.js` uses, pointed at the real robot
instead of a mock: ran `gofa-connection-status` against the robot with `T_ROB1` legitimately
stopped (pre-upgrade `BackgroundLed.mod` still on disk) → `moduleVersion.socket.status` and
`.background.status` both correctly `'unknown'` (socket ping failed for the former; background
ping succeeded but the old module reports no version, for the latter — two different reasons for
the same status, both correct). Then ran `gofa-setup` for real: uploaded the new
`MainModule.mod`, loaded it, motors on, started — final step reported `"OK (module v2.4.0)"`,
confirming the match case against a freshly-uploaded module. Re-ran `gofa-connection-status`
afterward: `socket.status` now `'match'` (v2.4.0), `background.status` still `'unknown'`
(`BackgroundLed.mod` itself hasn't been reloaded — that needs the manual FlexPendant procedure
documented in the "Background LED task" section above, not automatable). `BackgroundLed.mod`'s
own `MODULE_VERSION` addition is code-complete but **not yet live-verified** — re-verify once
that task is next reloaded via the FlexPendant procedure.

**Watchdog flow (`flows/watchdog_flow.json`)**: a 30-second `inject` timer → a reentrancy-guard
`function` node (`flow.get('watchdogRecovering')`, returns `null` to skip a tick already mid-
recovery) → `gofa-connection-status` → a `function` node computing the actual wedge signature —
**`rws.ok && rws.rapid === 'running' && socket.ok === false && !egmActive`** — RAPID *claiming*
to run while its own socket server isn't answering is the specific contradiction that means
"genuinely wedged," as opposed to a legitimate stop (teach workflow, a user-initiated stop),
where `rws.rapid` is `'stopped'` and the socket being down is expected, not a bug. A `switch`
node gates on that boolean; only a real wedge proceeds. On a wedge: capture evidence
(`gofa-elog` then `gofa-rapid-tasks`, run **sequentially** — an earlier draft fanned these out in
parallel into a shared next node, which double-fires everything downstream since two independent
messages would each traverse the whole recovery chain; caught before landing, not a live
incident) → recovery chain `gofa-rapid-exec` `stop` → `change` (clear `msg.payload` to `{}`) →
`resetpp` → `change` → `start` → `change` → `gofa-connection-status` (the actual "did it work"
check) → a final `function` node bundling the evidence + outcome into one payload and clearing
the reentrancy flag → `debug` node (a real notification integration — email/Slack/etc. — is left
as an obvious downstream extension point via a `comment` node, not built).

**Live-tested**: the wedge-detector correctly returns `false` against the real robot with RAPID
legitimately stopped (not a false positive) and again once healthy (`running`/`motoron`/`match`).
The recovery chain's individual mechanics — `stop` → (cleared payload) → `resetpp` → (cleared
payload) → `start` → recheck — were driven live via the real `gofa-rapid-exec`/
`gofa-connection-status` node files in the exact sequence the flow uses, confirming zero
chaining-hazard warnings (proving the `change` nodes' payload-clearing does what it's meant to)
and a clean `running`/`motoron` end state. **Not live-tested**: the flow's actual wedge
*trigger* path end-to-end (switch → evidence capture → recovery), since deliberately reproducing
the real wedge bug on live hardware risks the same unresolved failure mode this feature exists to
recover from — the decision logic and the recovery mechanics were each verified live
independently instead. If "Too many EGM instances"-style caution is ever warranted here too:
watch the first few real wedge events this flow handles for any surprising interaction, same as
any first real usage of automated recovery logic.

**`egmActive` exclusion — a real bug caught the day after shipping, not theoretical.** An
active `gofa-egm` session leaves `rws.rapid` at `'running'` for the session's whole duration (the
TRAP/`EGMStop` design in the EGM section above deliberately never stops the task) while closing
T_ROB1's socket — the exact same `{running, socket down}` shape as a genuine wedge. The original
version of this doc (and the flow) wrongly listed EGM sessions alongside teach-workflow as "a
legitimate stop" — they're not: `rws.rapid` stays `'running'`, not `'stopped'`, during EGM,
unlike a real stop. Without an exclusion, any EGM session running longer than one 30s poll
interval would be misdiagnosed as wedged and forcibly stop/resetpp/start RAPID mid-session —
exactly the kind of external interruption the EGM section's own TRAP design and
resetpp-before-next-start rule exist to warn about. Fixed by adding `egmActive: !!r._egmActive`
to `gofa-connection-status`'s payload (cheap — it's already-tracked in-memory state on the
`gofa-robot` config node, no new RWS/socket calls) and `&& !egmActive` to the wedge condition.
Unit-tested against the exact documented EGM shape (`rapid: 'running'`, `socket.ok: false`,
`egmActive: true` → not wedged); `egmActive: false` confirmed live against the real robot in its
normal (non-EGM) state — the `true` case wasn't forced live (would need `MainModuleEGM.mod`
loaded plus a real EGM session, out of scope for this fix). Teach workflow was re-checked at the
same time and is genuinely fine as documented: it does stop RAPID before lead-through, so
`rws.rapid` really does go to `'stopped'`, which never matches the wedge condition regardless of
`egmActive`.

## Interactive properties panels (2.2.0+, undocumented until 2026-07-16)

Since 2.2.0, every non-config node's properties dialog has live-action buttons/live-read
panels — "Jog Now", "Read Value", "Test Connection", etc. — that call the *real* robot right
from the editor, independent of whether the flow is deployed. This is a completely separate
code path from the runtime `node.on('input', ...)` handler:

- Each button is wired in `oneditprepare` (in the node's `.html`) to a plain `$.ajax`/`$.getJSON`
  call against a `RED.httpAdmin.get/post('/gofa-<node>/:id/<action>', RED.auth.needsPermission(...), ...)`
  route registered in the node's `.js` file. That handler looks up the robot config node via
  `RED.nodes.getNode(req.params.id)`, calls `robot.socketSend(...)`/`robot.rwsGet/rwsPost(...)`
  directly, and replies with `res.json(...)`.
- **It never calls the node's own `send()`.** Clicking a panel button moves the robot (or reads
  live state) for real, but nothing propagates to whatever is wired to that node's output, even
  in a deployed flow — the two code paths (admin endpoint vs. `on('input')`) don't intersect.
- Read-only routes (`.read`, all GET) are gated with `RED.auth.needsPermission('gofa-<node>.read')`,
  which grants nothing when no `adminAuth` is configured — but they only read. **State-changing
  routes (`.write`, all POST — the 23 motion/motor/IO/RAPID-write endpoints) are gated with
  `requireAdminAuth(RED, 'gofa-<node>.write')` (`nodes/lib/require-admin-auth.js`) as of 2.4.10,
  not the bare `needsPermission`.** That wrapper: delegates to `needsPermission` when `adminAuth`
  IS configured (unchanged behavior); returns **403** when it is NOT, so an unauthenticated
  editor port can no longer trigger motion via a bare request (the old hole — browser `confirm()`
  dialogs were UI-only, never a server-side check). Escape hatch for cells relying on network
  isolation instead of `adminAuth`: the `gofa-robot` config node's **Allow insecure live control**
  checkbox (`robot.allowInsecureLiveControl`) makes the wrapper fall through to `next()` even with
  no `adminAuth`. The `.read`/`.write` split maps exactly to GET/POST here, so the rule is simply
  "every `.write` endpoint is guarded" — confirmed by a repo-wide grep when this shipped. Deployed
  flows are unaffected (they use `node.on('input')`, never the admin endpoints). See the README's
  Safety and security section.
- Cross-node shared state (`gofa-sequencer`'s `robot._seqRunning`/`_seqStop`) is genuinely
  shared between the panel's admin-endpoint run and a deployed flow's runtime run of the *same*
  node type on the *same* robot config node — starting one from the panel while the other is
  also active will interact (see `gofa-sequencer.js`'s runtime handler: any new `on('input')`
  message while `_seqRunning` is true treats it as a stop request).
- `gofa-sequencer`'s panel keeps its **Stop Sequence** button always enabled regardless of the
  polled `/status` result (fixed 2.2.2) — the polled `running` flag can lag or drop before the
  robot has actually finished moving, and a kill switch that disables itself right when it's
  needed most defeats the point. Only **Start** is gated on the polled status (server-side also
  rejects a second concurrent start regardless, so this is redundant, not load-bearing).

## Known Signals dropdown (2026-07-21)

`gofa-di-read`, `gofa-do-write`, `gofa-grip`, and `gofa-subscribe-io` each have a **Known
Signals** `<select>` above their existing free-text Signal field, populated live from
`GET /rw/iosystem/signals` via a new per-node admin route (`RED.httpAdmin.get('/gofa-<node>/:id/signals', ...)`,
same `RED.auth.needsPermission`-gated pattern as the "Interactive properties panels" routes
above). The first option is always **`Other (type below)`** (empty value) — selecting it is a
no-op, leaving the text field exactly as before; picking a real signal just copies its name into
that same text field, which stays fully editable either way. `gofa-di-read` filters to `DI`,
`gofa-do-write`/`gofa-grip` filter to `DO`, `gofa-subscribe-io` shows every signal type
unfiltered (it can monitor any of them, including the ASI buttons). The XHTML `<li
class="ios-signal-li">` parsing (previously duplicated twice inside `gofa-io-list.js`) was
extracted into a shared `nodes/lib/list-signals.js` helper, which all five of these routes/nodes
now use — `gofa-io-list.js` itself was refactored to call it too, confirmed behavior-preserving
by its existing test.

**Race-condition fix, found by an agy second-opinion review before this shipped**: the dropdown
is re-populated on every Robot-field change, and the original version only cleared the `<select>`
once, synchronously, before kicking off the `$.getJSON` fetch — not again when the response
landed. Two overlapping populate calls (e.g. switching the Robot dropdown twice before the first
fetch resolves) could each append their own signal list into the same, already-populated
`<select>`, producing duplicate options. Fixed by re-clearing the list inside `.done()` too, so
whichever response lands last always rebuilds from a clean slate regardless of ordering.

## Nodes (43 total)

| Node | Transport | Description |
|------|-----------|-------------|
| `gofa-robot` | config | Shared config: IP, RWS port 443, socket port 1025, creds, local points file, remote (on-robot) points path, optional per-axis **Joint Limits** override (see the joint soft-limit note below). Config dialog has a **Discover** button (admin endpoint `/gofa-robot/discover` → `discover()` LAN scan, verifies ABB via WWW-Authenticate realm) |
| `gofa-setup` | RWS + Socket | One-click first-run init: preflight (must be Auto mode — RWS can't change opmode) → stop RAPID → unload conflicting MainModule/MainModuleEGM sibling → upload bundled `.mod` (SERVER_IP auto-synced) → loadmod → resetpp → motors on → start (verified by polling, HTTP 200 lies) → socket PING (also compares the module's reported version against the palette's, warning in that step's `detail` on drift — see the "Module version handshake" note below). Per-step `{name, ok, detail}` report; `outputPayload` defaults **true** (the report is the point). Module files read from the package's own `rapid/` dir (synced by prepack.js) |
| `gofa-status` | RWS | Reads ctrlstate, opmode, speedratio, RAPID execstate |
| `gofa-connection-status` | RWS + Socket + Background | Checks RWS (4 calls), the T_ROB1 TCP socket ping, and the `BackgroundLed.mod` background-task ping independently — each failure is caught and reported per-layer instead of the whole node throwing on the first one down. `msg.payload.background` distinguishes "T_ROB1 specifically stopped" from "whole controller unreachable". `msg.payload.moduleVersion` reports each ping's module version vs. the palette's own (`match`/`mismatch`/`unknown` — see the "Module version handshake" note below); a mismatch (but otherwise-healthy) result sets yellow status instead of green. `msg.payload.egmActive` mirrors `robot._egmActive` — needed so a consumer polling this node (like `flows/watchdog_flow.json`) doesn't mistake an active EGM session's `{rapid:'running', socket down}` shape for a genuine wedge. Unlike `gofa-status`, a degraded/unreachable result is still a successful run (no Node-RED error raised), so it's safe to poll on a timer — this is what `flows/watchdog_flow.json` polls. |
| `gofa-pose` | RWS | Current TCP pose (x,y,z + quaternion + config flags) |
| `gofa-joints` | RWS | All 6 joint angles in degrees |
| `gofa-system-info` | RWS | RobotWare version, controller name/ID/type/MAC |
| `gofa-elog` | RWS | Controller event log entries; Domain (category, not severity) + Min Severity (info/warning+/error-only) filters |
| `gofa-motor` | RWS | Motor on/off via `POST /rw/panel/ctrl-state` |
| `gofa-move` | Socket | HOME or SETHOME |
| `gofa-movej` | Socket | Absolute joint move; Move type dropdown Joint (MoveAbsJ, default) / Linear (CalcRobT + MoveL) — displayed as "Move Joints", type id unchanged for compat. Validates each target angle against the robot's Joint Limits before sending (see the joint soft-limit note below) |
| `gofa-jog` | Socket | Cartesian jog (X/Y/Z ± mm or RX/RY/RZ ± °) |
| `gofa-joint-jog` | Socket | Single joint jog |
| `gofa-grip` | RWS | Named DO signal on/off via `/set-value` (needs `Access: All` on that signal); editor has a Known Signals dropdown (DO-filtered, see above) alongside the free-text field |
| `gofa-zone-set` | Socket | Set path blend zone |
| `gofa-speed-set` | Socket | Global speed override via RAPID's `VelSet` (not `SpeedRefresh` — see the `SPEED`/`SpeedRefresh` note above for why); Action dropdown — Set (`speed` cmd) or Read current (`getspeed` cmd, reads `C_MOTSET.vel.oride`, genuinely reflects Set). Neither needs mastership; both need RAPID running. `msg.payload` accepts `{speed}`/`{action}` object-form overrides, matching the rest of the palette's override convention. **Chaining hazard**: its own `{ok, action, speed}` output can be misread as another instance's `action` override — same class as `gofa-rapid-exec`/`gofa-asi-led` |
| `gofa-stop-motion` | Socket | Halt motion — immediate for a jog in progress, but only takes effect after the current move finishes for `HOME`/`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL` since 2.4.2 (see the `\Conc` queue-depth crash note above) |
| `gofa-ping` | Socket | Connectivity test, measures round-trip time |
| `gofa-save-point` | RWS + disk/RWS | Read pose via RWS, save as named point in `points.json` (Local) or a JSON file on the robot's own disk (On-Robot) |
| `gofa-go-point` | Socket + disk/RWS | Look up saved point (Local `points.json` or On-Robot file), send GOTO token; move type (MoveJ/MoveL) selectable per-node or per-message |
| `gofa-point-list` | disk/RWS | Output full saved-point array, from `points.json` (Local) or the robot's own disk (On-Robot) |
| `gofa-delete-point` | disk/RWS | Remove a saved point by name, from `points.json` (Local) or the robot's own disk (On-Robot) |
| `gofa-points` | disk | Dump points list to `msg.payload` (action `export`) or **replace** it from `msg.payload`/file (action `import`) — local storage only. Bare-string payload stays a file path (NOT an action override); only `msg.payload.action` overrides |
| `gofa-sequencer` | Socket + disk/RWS | Visit saved points in order (Local `points.json` or On-Robot file); per-step dwell + move type override, loop count, ping-pong, startStep |
| `gofa-stop-seq` | Socket + in-memory | Sets `_seqStop` flag and sends immediate `STOP` socket command |
| `gofa-rapid-exec` | RWS | Start/stop/resetPP/loadmod/unloadmod/activate RAPID program *(requires Remote Start/Stop UAS grants; resetpp/loadmod/unloadmod/activate need Edit mastership, granted automatically)* |
| `gofa-rapid-var-read` | Socket | Read a RAPID PERS variable via `GETVAR:<name>` socket command |
| `gofa-rapid-var-write` | Socket | Write a RAPID PERS variable via `SETVAR:<name>:<value>` socket command |
| `gofa-rapid-tasks` | RWS | List RAPID tasks and the modules loaded in one of them |
| `gofa-file` | RWS | Controller filesystem: action `download` / `upload` / `delete` (delete is new in 2.0.0, uses the fileservice DELETE confirmed live 2026-07-15). Upload auto-syncs `SERVER_IP` to the config node's IP (`patchServerIp`, now in `nodes/lib/patch-server-ip.js`, no-ops on files without the constant). Bare-string payload = remotePath for download/delete, localPath for upload |
| `gofa-mod-edit` | RWS | Edit a controller-disk file in the node's edit dialog: file dropdown ($HOME/Programs, admin endpoint `/gofa-mod-edit/:id/files`) or new filename, ace editor, Load/Save/**Delete**-from-robot buttons (SERVER_IP auto-synced on save); runtime input re-uploads stored content. Directory-listing parse (`parseFileList`) **confirmed live 2026-07-15**: entries are `<li class="fs-file" title="<name>">` (name in the `title` attr — the parser's first-choice path; the anchors carry the name only in `href`, with empty text), plus `fs-cdate`/`fs-mdate`/`fs-size`/`fs-readonly` spans. `fs-dir` shape still unobserved (no subdirs existed). Also confirmed live: fileservice `DELETE /fileservice/<path>` works (`204`, then `404` on GET) — first confirmed RWS file-delete in this project. **Delete from robot** button added 2026-07-20 (`DELETE /gofa-mod-edit/:id/file` admin endpoint, confirm dialog, refreshes the file list after) — confirmed live end-to-end via the real handler: upload → delete (`200 {ok:true,deleted:true}`) → follow-up GET `404` → repeat delete on the already-gone file correctly `404`s too |
| `gofa-io-list` | RWS | List all I/O signals |
| `gofa-di-read` | RWS | Read digital input; editor has a Known Signals dropdown (DI-filtered, see above) alongside the free-text field |
| `gofa-do-write` | RWS, Socket, or Background task | Write digital output; Transport dropdown — RWS `/set-value` (needs `Access: All`), Socket `SETDO` (needs RAPID/T_ROB1 running, no Access Level restriction), or Background task (same `SETDO` allow-list via `BackgroundLed.mod`, works while T_ROB1 is stopped); editor has a Known Signals dropdown (DO-filtered, see above) alongside the free-text field |
| `gofa-leadthrough` | Socket + RWS | Hand-guiding: action `enable` (checks RAPID execution state first — sends socket STOP to clear queued moves only if RAPID is genuinely running, tolerates socket-down; skips the socket call entirely when RAPID is already stopped, avoiding a ~5s wasted timeout — see the "Correction, 2026-07-20" note above) / `disable` (RWS only) |
| `gofa-asi-led` | Socket, RWS, or Background task | Set ASI status light RGB color + counted software blink; Transport dropdown — Socket `SETLED`/`RESETLED` (needs T_ROB1 running), RWS `/set-value` (needs Access Level: All, not available on this controller's ASI board), or Background task (`BackgroundLed.mod` in its own RAPID task, works while T_ROB1 is stopped) |
| `gofa-subscribe-state` | RWS WS | Push on every controller state change; one-shot mode polls once per inject |
| `gofa-subscribe-io` | RWS WS | Push on every I/O signal change (real WebSocket push, confirmed live down to a single button tap); falls back to 500 ms polling only if the subscribe request itself fails; one-shot mode available; editor has a Known Signals dropdown (unfiltered, see above) alongside the free-text field |
| `gofa-subscribe-var` | RWS poll | Poll a RAPID variable on an interval; toggles on/off per inject |
| `gofa-subscribe-pose` | RWS poll | Poll TCP position on an interval; toggles on/off per inject |
| `gofa-subscribe-elog` | RWS WS | Push new controller event log entries in real time (bare `/rw/elog/<domain>` subscription — no `;suffix`, unlike other subscribe nodes; the push only carries a `seqnum` reference, so the node fetches the full entry before emitting); same Domain + Min Severity filters as `gofa-elog` |
| `gofa-egm` | Socket + UDP (EGM) | Session control + telemetry — Action dropdown (start/stop) sends `EGMJOINT`/graceful-stop signal, holds pose, emits throttled feedback. Requires `MainModuleEGM.mod` loaded, not the default `MainModule.mod` — see EGM section above. Best-effort sets the ASI LED (via the Background transport) to a distinct color while streaming, resets on stop |
| `gofa-egm-move` | In-memory (shared robot state) | Sets the live EGM joint target if a `gofa-egm` session is active (output 1); otherwise routes unchanged to a fallback output (output 2), e.g. into `gofa-movej` |

## Saved points format

Stored in `points.json` on the Node-RED host by default (local storage):
```json
[{ "id": "uuid", "name": "pick1", "target": { "x":323.2, "y":-81.8, "z":807.0, "q1":0.267, "q2":0.129, "q3":0.954, "q4":-0.053, "cf1":-1, "cf4":-1, "cf6":0, "cfx":0 } }]
```
GOTO token rounds to 1 dp (xyz) / 4 dp (quaternion) to stay under RAPID's 80-char string limit. RAPID re-normalizes the quaternion on receipt.

**On-robot storage note**: `gofa-save-point`/`gofa-go-point`/`gofa-delete-point`/`gofa-point-list`/`gofa-sequencer` all have a **Storage: Local / On-Robot** option (`msg.payload.storage` override, `'local'`/`'remote'`). On-Robot stores the exact same JSON shape above in a file on the robot controller's own disk (`gofa-robot`'s **Remote Points Path**, default `$HOME/Programs/gofa_points.json`) instead of `points.json` — no local file needed on the Node-RED host. This does **not** touch `MainModule.mod` or RAPID at all: the file is managed purely over RWS `fileservice` `GET`/`PUT` (`gofa-robot.js`'s `remoteGetPoints`/`remoteAddPoint`/`remoteDeletePoint`/`remoteFindPoint`/`remoteSavePoints`), the exact mechanism `gofa-file` already uses. Movement is completely unaffected either way — `gotoToken()`/`socketSend()` and the `GOTOJ`/`GOTOL` socket protocol don't know or care where the point came from.

Originally considered storing the list *inside* RAPID (new socket commands reading/writing a file from within `MainModule.mod`), but RAPID's `string` type has a hard 80-character cap (see the GOTO-token rounding above) that a growing list of named points would blow past for more than a point or two — confirmed live: `GET`/`PUT /fileservice/$HOME/Programs/gofa_points_test.json` round-trips a JSON list with no RAPID string involved at all (plain HTTP), which sidesteps the limit entirely. Two things confirmed live building this: `GET` on a missing file is a clean `404` (`rapi_file_service.cpp: Path does not exist`) — treated as `[]`; `PUT` **requires** `Content-Type: text/plain;v=2.0` or `application/octet-stream;v=2.0` — `application/json` is rejected (`415`, and the error body itself names the two valid options). No concurrent-write protection on the remote file (unlike local storage's changed-on-disk mtime check) — acceptable for a human-paced "teach a point" workflow, not built.

## RWS key endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `GET /rw/panel/ctrl-state` | GET | `ctrlstate`: motoron/motoroff/guardstop/emergencystop |
| `GET /rw/panel/opmode` | GET | `opmode`: **UPPERCASE live** (`AUTO`, …) — unlike lowercase `ctrlstate`/`ctrlexecstate`; compare case-insensitively (bit `gofa-setup`'s preflight, confirmed live 2026-07-15) |
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
| Robot IP | `192.168.1.103` (confirmed live 2026-07-16 via `/robot-status`; **drifts often, including whole-subnet changes** — was `192.168.20.33` → `.36` → `192.168.20.14` → this. Never trust this table over a live check — see the `reference_robot_ip_drift`/`project_robot_current_ip` memories) |
| RWS port | `443` (HTTPS, self-signed cert — `rejectUnauthorized: false`) |
| Socket port | `1025` |
| Username | `NNNN` |
| Password | *(not written in this repo — see the `user-robot-credentials` live memory; it's still the ABB factory default, and `check-status.js`/`mastership-test.js` fall back to it, so live tests work with no env setup)* |

The *shipped* `gofa-robot` node default was genericized for the public npm release (2026-07-08):
username defaults to ABB's factory `Default User`, password has no default — so a fresh public
install never carries this lab's creds. This repo is public: don't write the actual password
into any tracked file; it lives in the local (non-repo) Claude memory only.

## RobotStudio virtual controller (VC) workflow — doc-only guidance, NOT live-verified

**Status: written from ABB's documented RWS/VC behavior and this project's own confirmed RWS
findings, but never actually run against a live virtual controller — no VC instance was
available in this dev environment when this section was written (2026-07-20). Treat every
claim below as "should work per the docs," not "confirmed," until someone actually points a
`gofa-robot` config node at a real VC and runs `check-status.js` against it.** This is
`ideas/improvement-roadmap.md` item #4 (learning-oriented, robot-free dev/demos) — this section
is the doc half only; the verify half is still open.

**Why this should work at all**: RWS is served by the controller software itself (`robotware`),
not the physical hardware — a Virtual Controller in RobotStudio runs the identical RobotWare
stack this project already targets (pin the VC's RobotWare version to `7.21.0+229` to match, or
expect the RWS-generation caveats below to shift). Nothing in `gofa-robot.js` or any node file
assumes physical hardware; every call goes through RWS or the RAPID socket server, both of which
a VC serves the same way a real controller does.

**Connection settings — the one thing genuinely different from the physical robot**:
- **IP**: a VC normally only listens on `127.0.0.1`/`localhost` unless RobotStudio's "Virtual
  Controller network" is explicitly bridged to a real adapter. If Node-RED runs on the *same*
  Windows machine as RobotStudio (the common case for this kind of robot-free dev), set the
  `gofa-robot` config node's IP to `127.0.0.1`. If Node-RED runs elsewhere, RobotStudio's VC
  networking needs to be configured to expose the VC on a reachable interface first — not
  attempted here, not documented by ABB in a way this project has reviewed yet.
- **RWS port / socket port**: unchanged — `443` and `1025` (or `1026` for `BackgroundLed.mod`),
  same as the real robot, since these are RobotWare-level ports, not hardware-tied.
- **`SERVER_IP` in `MainModule.mod`**: this is RAPID's own `SocketBind` address (see the
  `SERVER_IP note` above) — for a VC it needs to be the VC's own bind address, almost certainly
  `127.0.0.1`, not the physical robot's LAN IP. `gofa-file`'s upload/`gofa-setup`'s
  `patchServerIp` already rewrites this to the configured `gofa-robot` IP on every upload, so
  pointing the config node at the VC's IP should carry through automatically — unverified.
- **Credentials**: VCs default to RobotWare's own factory defaults (`Default User` / no set
  password, or a station-specific login configured when the VC was created) — not necessarily
  this lab's `NNNN`/factory-default credentials. Check whatever the VC station was configured
  with in RobotStudio's Controller tab.

**Where this project's own confirmed RWS findings are expected to differ on a VC** (each one
already independently confirmed against the real controller elsewhere in this doc — re-verify
against the VC rather than assuming, since a VC is a different RobotWare install/config, not
just a different network location):
- **ASI status light (`gofa-asi-led`'s RWS/Socket/Background transports)**: the physical ASI
  board is real hardware (see the "Background LED task" section) — a default VC station likely
  has no ASI signals at all, so `SETLED`/`RESETLED`/the RWS transport would need either a
  VC I/O configuration that fakes equivalent signals, or this feature simply doesn't apply on a
  VC. Not something to "fix" — just an expected VC/real-hardware gap.
- **EGM (`gofa-egm`/`MainModuleEGM.mod`)**: `EGMActJoint`/`EGMRunJoint` are pure RAPID/RobotWare
  instructions and should work on a VC in principle, but the whole mechanism rides on a UDPUC
  transmission protocol (`EGM_PC`) pointed at a real host IP:port — same VC-networking caveat as
  above, likely harder here since it's a live UDP stream, not a request/response RWS call.
  Timing fidelity (the ~24ms EGM frame rate this project's docs cite) is also worth treating as
  unverified on a VC — simulated RobotWare instances are not guaranteed to hold the same
  real-time timing a physical controller's motion core does.
- **Digital I/O (`gofa-do-write`/`gofa-di-read`/`gofa-io-list`)**: works against whatever I/O
  signals the VC station defines — a default GoFa 12 VC station may not include the DSQC1030
  Scalable I/O board's `ABB_Scalable_IO_0_DI/DO*` signals unless that hardware module was added
  to the station in RobotStudio. `SETDO`'s allow-list in `MainModule.mod`/`BackgroundLed.mod`
  (`TrySetDo`) is hardcoded to those exact names — a VC without that I/O module configured would
  need either the station updated to include it, or the allow-list edited to match whatever
  signals the VC actually has.
- **Motion / socket protocol (`GOTOJ`/`GOTOL`/`MOVEJ`/`MOVEL`/jog commands, `\Conc` behavior)**:
  should be identical — this is pure RAPID logic with no hardware dependency, and the
  `\Conc` queue-depth fix (2.4.2) is a RobotWare-level behavior, not a physical-controller quirk.
  Reasonable first thing to actually verify live once a VC is available, since a mismatch here
  would mean the fix doesn't generalize the way its writeup assumes.
- **Multitasking (`T_LED`/`BackgroundLed.mod`)**: RobotWare Multitasking `[3114-1]` is a licensed
  option (confirmed on the real controller via `GET /rw/system` — see the `omnicore-c30` skill);
  a VC station needs the same option enabled in its RobotWare configuration or task-creation
  will hit the same "RWS can't create tasks" wall documented in the "Background LED task"
  section, this time with no RobotStudio-GUI escape hatch either (VCs are configured through the
  same Controller tab, so the workflow should transfer, but the *licensing* needs to be present
  in the VC's own RobotWare System Builder config, not inherited from the real controller).

**Suggested first live-verification pass, when a VC is available**: `check-status.js` with
`GOFA_IP=127.0.0.1` (and matching creds) against a freshly-created default GoFa 12 VC station,
then `gofa-setup` for the one-click init, then basic motion (`MOVEJ`/`GOTOJ`) — that alone would
confirm or correct most of the guesses above about what transfers unmodified vs. needs VC-side
configuration.

## Software versions (RobotWare/controller re-confirmed live 2026-07-16 via `check-status.js --full`; Node.js/Node-RED re-confirmed against the dev machine same date; RobotStudio not reverified this pass)

| | |
|---|---|
| RobotWare | `7.21.0+229` |
| RWS protocol generation | `2.0` (path-based actions, `/set-value` not `/set`, `hal+json;v=2.0` for `loadmod`/`activate`) |
| Controller | OmniCore C30 Type A, identity `15000-501318` |
| Robot | CRB 15000-12/1.27 (GoFa 12) |
| RobotStudio (engineering tool, used for I/O config) | `2026.2`, build `26.2.11700.0` *(unverified since 2026-07-07)* |
| Node-RED | `5.0.0` (`npm ls -g node-red`) | 
| Node.js | `v24.18.0` (`node --version`) |

Full product/option breakdown (RobotOS, ASI, EGM/Multitasking licensing, etc.) is in the `abb-rws` skill's version-snapshot section — re-pull via `GET /rw/system` + `GET /rw/system/products` rather than trusting this table blind after any ABB software update.

## Repo layout

```
node-red-contrib-abb-gofa/        ← npm palette package
node-red-contrib-abb-gofa/check-status.js  ← standalone robot preflight check, see /robot-status above
node-red-contrib-abb-gofa/mastership-test.js ← standalone mastership-gated RWS test, see /mastership-test above
rapid/MainModule.mod               ← RAPID socket server (must run on controller)
rapid/MainModuleEGM.mod            ← optional: MainModule.mod clone + EGM mode (gofa-egm), see EGM section
rapid/BackgroundLed.mod             ← optional: separate-task LED server, survives T_ROB1 stop, see Background LED task section
flows/gofa_demo_flow.json          ← one inject per node, for testing
flows/teach_workflow_flow.json     ← physical ASI-button teach workflow (own tab/config, see README)
flows/watchdog_flow.json           ← self-healing socket-wedge watchdog, see "Module version handshake + watchdog flow" section
flows/mqtt_bridge_flow.json        ← publishes state/pose/io onto MQTT topics via core mqtt out; fully live-verified end-to-end against a local Mosquitto (localhost:1883) and the real robot
MANUAL_CONTROL.md                  ← curl/raw-TCP command reference for controlling the robot without Node-RED
.claude/commands/                  ← skills (/abb-rws, /omnicore-c30, /crb15000, /robot-status, /mastership-test)
.claude/memory/                    ← portable snapshot of Claude Code's project memory - read MEMORY.md first, see its README
.claude/plans/                     ← portable snapshot of past feature plans (design history, not active todos)
```

**Rule — every `.mod` edit must be synced into the npm package copy, same commit.**
`rapid/*.mod` (repo root) is the source of truth; `node-red-contrib-abb-gofa/rapid/*.mod` is
the copy that ships on npm **and the one `gofa-setup` reads at runtime** — a stale package copy
means one-click setup installs outdated RAPID code on a dev/git install (prepack.js only
re-syncs at `npm pack`/publish time, not on commit). After editing any root `rapid/*.mod`, copy
it to `node-red-contrib-abb-gofa/rapid/` (or run `node prepack.js` from the package dir).
Enforced: `test.js` has a byte-for-byte drift check that fails the suite if the copies differ.

**`flows/dashboard_flow.json` removed from `main` (2026-07-16), lives only on the local
`feature/mobile-pwa-dashboard` branch — not pushed to GitHub.** That branch's commit 99b870d
did two things in one: (1) the same `outputPayload`/stale-IP/stale-version fix already applied
to the teach/demo flows, and (2) a new second tab adding a phone-friendly PWA control panel
built on `@flowfuse/node-red-dashboard` ("Dashboard 2.0"). The `ui-*` widget schemas were
verified against Dashboard 2.0's real source (not memory) but never actually imported into a
live Node-RED + Dashboard 2.0 instance — no such instance exists in this dev environment. Once
`test.js` gained a check requiring every `flows/*.json` example to have `outputPayload` set
correctly (added 2026-07-16, same day), keeping the *fixed-but-not-PWA* version of
`dashboard_flow.json` on `main` while the *fixed-with-PWA* version sat on the branch would have
meant permanently maintaining two diverging copies of the same file. Simplest resolution:
pulled the file off `main` entirely rather than let it drift; it comes back (fixed, with or
without the PWA tab) once the branch's Dashboard 2.0 widgets are actually import-tested. Full
history: [[project_mobile_pwa_dashboard_branch]] memory.

**On continuity across machines**: this project's Claude Code memory (hard-won lessons, decisions,
live-test history) normally lives outside the repo, keyed to the local clone's working-directory
path — it doesn't travel when this repo is cloned elsewhere. `.claude/memory/` and `.claude/plans/`
are manually-copied snapshots of that history, committed to the repo so a fresh clone (new
machine, or anyone else picking this up) starts with the same context instead of from zero. They
go stale the moment new memory accumulates outside them — worth re-syncing periodically, not just
once. Start any "what's the history here" question with `.claude/memory/MEMORY.md`.
