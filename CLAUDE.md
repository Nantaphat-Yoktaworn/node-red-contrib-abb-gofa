# ABB GoFa 12 (CRB 15000-12/1.27) — Claude Code Context

Custom Node-RED palette (`node-red-contrib-abb-gofa`) for controlling an ABB GoFa 12 (CRB 15000-12/1.27) collaborative robot over a local network. No extra ABB licenses required.

## Skills available

- `/abb-rws` — full RWS API reference (endpoints, auth, response parsing)
- `/omnicore-c30` — OmniCore C30 controller specs
- `/crb15000` — GoFa arm specs, joint limits, working range
- `/robot-status` — runs `check-status.js` (below) against the live controller and reports Motors/Mode/RAPID/Speed/Socket; use before any live RWS/socket test, not just when explicitly asked
- `/mastership-test` — runs `mastership-test.js` (below) to live-test any mastership-gated RWS endpoint (`resetpp`, `loadmod`, `activate`, RAPID var writes, or a newly-discovered one); use instead of hand-rolled `curl` any time a task is "try/verify a mastership-gated RWS action live"

## Standalone status-check script

`node-red-contrib-abb-gofa/check-status.js` — plain Node.js, no Node-RED runtime needed. Run directly (`node check-status.js`) to preflight-check the robot before a live test: Motors/Mode/RAPID/Speed via RWS, plus a socket `PING` (the motion socket server only runs while RAPID is actually executing, so `RAPID: stopped` reliably means the socket ping will fail too — that's expected, not a bug). Flags: `--full` (adds RobotWare version, controller identity, `T_ROB1` task state, last 3 error/warning elog entries), `--json`, and `--discover` (scans active IPv4 subnets for any ABB GoFa controllers). If the configured IP is unreachable, it automatically triggers a fallback network scan to discover and test the controller. Connection defaults match this doc's table below except IP, which is `192.168.20.36` (drifted from the `.33` default — see the `SERVER_IP` note); override any of it per-invocation via `GOFA_IP`/`GOFA_RWS_PORT`/`GOFA_SOCKET_PORT`/`GOFA_USERNAME`/`GOFA_PASSWORD` env vars. Exit codes: `0` OK, `1` RWS unreachable, `2` RWS OK but socket unreachable. Built on `createRobotClient()`, a RED-independent factory extracted from `gofa-robot.js`'s session/auth/cookie logic (`GoFaRobotNode` now just delegates to it) — the same "export pure helpers for standalone use" pattern `test.js` already relies on for `parseXhtml`/`gotoToken`/etc.

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
| `SPEED50` | Set speed override 1–100% |
| `MOVEJ<j1;..;j6>` / `MOVEL<j1;..;j6>` | Absolute joint move in degrees — MOVEJ = MoveAbsJ (joint-interpolated), MOVEL = straight-line TCP path to the same joint pose (CalcRobT forward kinematics + MoveL, added 2.1.0; same singularity caveat as GOTOL) |
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

**SETDO note (kept as a working alternative, no longer the only option)**: `TrySetDo` in `MainModule.mod` adds a `SETDO:<name>:<value>` socket command using RAPID's `SetDO` against an explicit per-signal allow-list (`ABB_Scalable_IO_0_DO1`..`DO16` — same pattern as `TryGetVar`/`TrySetVar`, since RAPID can't resolve an arbitrary runtime string into a signal reference). Confirmed live end-to-end: socket `SETDO:ABB_SCALABLE_IO_0_DO1:1` → `OK:SETDO`, independently verified via an RWS read showing `lvalue: 1`; set back to `0`, re-verified; also confirmed unaffected by the signal's RWS `Access` level (works identically on `Default` and `All`, since RAPID itself always has `Rapid` access). Unknown signal name → `ERR:UNKNOWN_SIGNAL`; bad value → `ERR:PARSE`. Useful when you don't want to open a signal's `Access` to `All` (which permits any RWS client to write it) but still want Node-RED control.

**`gofa-do-write` Transport dropdown (2026-07-10)**: `gofa-do-write` now has a **Transport** option — **RWS** (default, `/set-value`, needs `Access: All`) or **Socket** (needs RAPID running, bypasses the Access Level restriction). The Socket option sends `{cmd:'setdo', name, val}` through `socketSend`, which reaches `DispatchJson`'s `"setdo"` case (added during the JSON socket-protocol rewrite) — **not** the legacy `TrySetDo` described above. This matters because `DispatchJson` matches the signal name **case-sensitively** against its ALL-CAPS `TEST` block, with no `CleanCmd`-style uppercasing (`CleanCmd` only runs on the legacy text protocol, and `DispatchJson` gets the raw JSON string, since blindly uppercasing would corrupt string-valued JSON fields). Confirmed live: sending this palette's own default signal name verbatim, `ABB_Scalable_IO_0_DO5` (mixed case), gets `ERR:SETDO` ("unknown signal"); the all-caps `ABB_SCALABLE_IO_0_DO5` succeeds. Fixed in `gofa-do-write.js` by upper-casing the name before sending over Socket — confirmed live end-to-end (via the real node code, not curl) that this now writes correctly, independently re-verified with an RWS read of `lvalue` after each write.

**Analog nodes removed (2026-07-07)**: `gofa-ai-read`/`gofa-ao-write` were deleted — confirmed live that this controller has zero `AI`/`AO` signals anywhere (only `DI`/`DO`/`GO` exist; the DSQC1030 is digital-only, and the C30 has no native analog port). Analog I/O would need ABB's `DSQC1032` Analog Add-On module, which attaches to the existing DSQC1030 digital base device rather than replacing it (see the `dsqc1030-scalable-io-addressing` memory). Re-add these nodes (same `/set-value`/plain-GET pattern as `gofa-do-write`/`gofa-di-read`) if that module is ever installed.

**`gofa-backup` and `gofa-restart` removed (2026-07-14)**: both nodes were added, then dropped after live testing showed the same failure. ABB's own documented backup-trigger call, `POST /ctrl/backup?action=backup` (verified against ABB's current Developer Center docs), returns a hard `405 Method Not Allowed` on this controller (RobotWare 7.21.0+229) — `OPTIONS /ctrl/backup` reports `Allow: GET,OPTIONS` only, no POST, regardless of the `?action=backup` query string, `Accept` header (tried `hal+json` too, same 405 pattern as `loadmod`), or HTTP verb (`PUT` also 405s). `/ctrl/backup/state` itself reads fine (`Backup Ready`), so the feature exists on this controller — only the documented create-call doesn't work as written. `gofa-restart`'s `POST /ctrl` (body `restart-mode=<mode>`) looked more solid on paper — code review reproduced ABB's own sample curl call verbatim and it matched exactly — but it **also** 405s live, despite `OPTIONS /ctrl` reporting `Allow: GET,POST,OPTIONS` (POST supposedly valid). Confirmed via the actual dashboard flow's `/robot/restart` HTTP endpoint, not just a raw curl guess. Same shape as the `/rw/rapid/symbols` finding above: ABB's own current docs failing verbatim against live, current firmware, and this time the "Allow header lies" pattern hit twice in one session on two different `/ctrl*` resources. Not investigated further (no working alternate path found for either); re-add only if a working trigger call is confirmed live first.

**SERVER_IP note**: `MainModule.mod` binds its socket server with `CONST string SERVER_IP := "..."`, which RAPID's `SocketBind` requires to be a real configured interface address (no wildcard bind). If this drifts from the controller's actual IP, `SocketBind` silently fails and every socket command times out with no error on the controller side. `gofa-file`'s upload action (and `gofa-setup`/`gofa-mod-edit`) mitigates this by always rewriting `SERVER_IP` to the `gofa-robot` config node's IP on every upload (`patchServerIp` no-ops on any file that doesn't contain the constant, so this is safe for uploading other files too); the constant in the repo copy is just the fallback for a first upload or manual FlexPendant/SD-card load.

**Module reload (`loadmod`) note**: reloading a module file already on disk into a running task (the FlexPendant's **Load Module** step) *is* possible over RWS, but not via the documented RWS 1.0/IRC5 query-action form — `POST /rw/rapid/tasks/{task}?action=loadmod` is `405` on this controller (same red-herring `Allow: GET,POST,OPTIONS` header as the `/rw/rapid/symbols` case below; that resource's real POST use is `/subscription`). The working call is **path-based**: `POST /rw/rapid/tasks/{task}/loadmod`, body `modulepath=<path>&replace=true`, and — the one exception in this whole palette — it requires `Accept: application/hal+json;v=2.0`, not the `xhtml+xml` every other endpoint uses (xhtml Accept errors on this resource). Gated on edit mastership, same as `resetpp`. Confirmed live against `T_ROB1`/`MainModule` (RobotWare 7.21.0+229): `200` with JSON body `{"state":[{"name":"MainModule", ...}]}`, no side effects. `gofa-rapid-exec`'s `loadmod` action wraps this (`rwsPostHal` in `gofa-robot.js` sends the hal+json Accept header). A companion `activate` action (`POST /rw/rapid/tasks/{task}/activate`, body `module=<name>`) works the same way and is now also wired into `gofa-rapid-exec`, as does `unloadmod` (`POST /rw/rapid/tasks/{task}/unloadmod`, body `module=<name>` — same hal+json/mastership requirements; removes the named module from the task only, the file stays on the controller's disk). `unloadmod` was needed once it was confirmed live that `loadmod`'s `replace` only replaces a *same-named* module — loading `MainModuleEGM` while `MainModule` is still loaded leaves both loaded, both declaring `PROC main()`, and RAPID rejects `resetpp`/`start` with `(87,5): Global routine name main ambiguous` (see the EGM section below). **All three require RAPID to be stopped** — confirmed live in both directions: succeeds (`204`) with `ctrlexecstate: stopped`, fails `403` (`rws_resource_rapid_task.cpp: Operation not allowed for current PGM state`) with `ctrlexecstate: running`, on the identical call. `gofa-rapid-exec` surfaces the RWS error's own reason text (previously discarded — `gofa-robot.js`'s `request()` only threw `HTTP <code> <path>` with no body detail) and adds a specific hint for this rejection. Full test log: see the `abb-rws` skill and the `project_robot_live_test_log` memory.

**GOTOJ/GOTOL note**: bare `GOTO<11 nums>` (no `J`/`L` letter) is still accepted by `TryGoTo` as an alias for `GOTOJ`, for backward compatibility. `gofa-go-point` and `gofa-sequencer` always send the explicit `J`/`L` form based on their "Move type" dropdown. `MoveJ` (joint-interpolated) is the more predictable/reliable choice — RAPID has freedom in how each axis gets there, so it won't fault or slow drastically near a singularity — and is therefore the default at every fallback point: `gotoToken(t, moveType)` in `gofa-robot.js` maps anything other than exactly `'L'` to `'J'`, and both nodes' config defaults are `'J'`. `MoveL` follows a straight line to the target and can hit singularities or joint limits along that line that `MoveJ` would route around, so it's opt-in, not a safer default.

**RAPID start note**: `POST /rw/rapid/execution/start` returns HTTP 200 even when the controller immediately rejects the start (e.g. RAPID error 20055, "program must start in Motor On state") — the rejection isn't surfaced as an HTTP error, so a naive implementation reports `{ ok: true }` for a start that never ran. `gofa-rapid-exec` guards against this for the `start` action only: it reads `/rw/panel/ctrl-state` first and fails fast if motors aren't on, then polls `/rw/rapid/execution` (`ctrlexecstate`) for up to 1.5s after the POST to confirm it actually reached `running`. `stop`/`resetpp` don't have this silent-rejection failure mode and aren't checked.

**RAPID symbol data note**: RWS's generic `/rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}` (the RWS 1.0 / IRC5-era documented endpoint for reading/writing any RAPID variable without touching RAPID code) returns `404 SYS_CTRL_E_UNRESOLVED_URL` on this controller. **Not a licensing issue** — verified against ABB's OmniCore C-line product manual (3HAC065034-001) that RWS is a standard, base-included feature, and that the OmniCore option in this area, RobotStudio Connect [3119-1], is unrelated (it's about the RobotStudio desktop app connecting over WAN). The real cause: `GET /rw/rapid` on this controller advertises `symbols` (plural), a search-based resource, not the flat singular `symbol` path from the general RWS docs — the same RWS 1.0-vs-2.0 shape split already seen for `execution` and `iosystem`. **Confirmed impossible, not just unresolved** — a later session fetched ABB's own current Developer Center pages for the exact official `search-symbols` call (method, path, query, form body) and reproduced it verbatim against the live controller (RobotWare 7.21.0+229): `POST /rw/rapid/symbols?action=search-symbols` with ABB's own documented body still returns `405 Method Not Allowed`, despite the response's own `Allow: GET,POST,OPTIONS` header claiming POST is valid; every path/method variant tried (singular action name, path-based action, GET-with-query, module-scoped `symbol` browser) is `404`/`405` or silently empty. This is ABB's own documented syntax failing on live, current firmware — not a guess this time. Full investigation, what was tried, and what's confirmed: see the `abb-rws` and `omnicore-c30` skills. This is why variable read/write goes through the custom TCP `GETVAR:`/`SETVAR:` protocol (allow-listed per variable in `TryGetVar`/`TrySetVar`) — proven and simple, not a workaround for a missing option. `gofa-subscribe-var`'s `readVar()` used to try the dead RWS symbol path before falling back to module-text on every poll; that guaranteed-fail round trip was removed once the endpoint was confirmed permanently broken on this hardware (not just occasionally), so it now goes straight to module-text and always reports `source: 'module-text'`.

**IO subscription note**: `gofa-subscribe-io`'s WebSocket subscribe request used resource suffix `;lvalue` (matching the attribute name a plain GET returns), but OmniCore's subscription service doesn't work that way — each RWS resource has its own fixed subscribable-resource keyword (`gofa-subscribe-state` already had this right, using `;ctrlstate` for `/rw/panel/ctrl-state`), and for I/O signals that keyword is the literal `;state`, not the value's own class name. `;lvalue` always got `400 Invalid resource URI` — confirmed live on both a top-level signal (`GOFA_MotorsOn`) and a device-scoped one (`Asi1Button2`), same path, only the suffix differed between 400 and 201. The `.catch` on that 400 fell through to 500 ms polling with no warning, so **every** signal was silently polling, not just ones that "lack WS support" (that was never a real distinction — no signal in this controller's IO list is WS-incapable; the request was just malformed). Fixed by changing the suffix to `;state`; re-verified by loading the actual patched node file and pressing `Asi1Button2` live — it connected as a real WS ("connected" status, not "polling") and pushed `source:'ws'` events with no poll delay on press and release. Practical implication: `gofa-subscribe-io` can now reliably catch fast events (e.g. a physical button tap) that a 500 ms poll could miss — worth revisiting anywhere the palette currently polls I/O as a workaround for "flaky WS," since that flakiness was this bug, not the hardware.

**Elog subscription note**: `gofa-subscribe-elog`'s subscribable resource is the **bare** `/rw/elog/<domain>` path — no `;suffix` at all, unlike every other subscribe node in this palette (`;ctrlstate` for panel state, `;state` for I/O signals). Confirmed live: every semicolon-suffixed guess (`;elog`, `;state`, `;lvalue`, `;log`) returned `400 Invalid resource URI`; only the bare path returned `201`. Also confirmed live: the WS push only carries a reference (`<li class="elog-message-ev">` with a `seqnum` and a self-`href`, e.g. `/rw/elog/1/17352`), not the entry's fields — the node does a follow-up `GET` on that href (`?lang=en`) to fetch `msgtype`/`code`/`title`/`tstamp` before emitting. That single-entry endpoint uses XHTML class `elog-message` (singular), not `elog-message-li` (the class the bulk list endpoint `gofa-elog` already parses) — same inner `<span>` fields, different wrapping class, so `gofa-subscribe-elog.js`'s `parseEntry()` matches either. End-to-end confirmed live: subscribing, then triggering a real new entry (a second client's fresh RWS login, which itself logs a `10400 "User ... logged on"` event) produced a genuine push → fetch → parse → emit round trip 2 seconds later, not just the initial-connection artifact.

**Elog domain vs. severity note**: `gofa-elog`'s original "Domain" dropdown (`0` = "All domains", `1` = "Controller (errors/warnings)") was never actually verified against the controller and turned out to be wrong on both counts. Confirmed live via `GET /rw/elog`: domain is a fixed ABB category list (`0`=Common, `1`=Operational, `2`=System, `3`=Hardware, `4`=Program, `5`=Motion, `7`=IO & Communication, `8`=User, `9`=Safety, `10`=Internal, `11`=Process, `12`=Configuration, `13`=Paint, `15`=RAPID, `17`=ConnectedServices) — domain `1` is "Operational", not "Controller", and has nothing to do with severity. Domain `0` ("Common") isn't a merge of every domain either: querying it live returned only 15 entries while domain `10` ("Internal") alone reported 97 in its own count — so picking a domain never gets you "all severities across everything," and picking domain `1` never filtered out info-level noise like "Motors On state." Severity (`msgtype`: `1`=info, `2`=warning, `3`=error) is a completely separate field on every entry, unrelated to domain. Both `gofa-elog` and `gofa-subscribe-elog` now have a real **Min Severity** filter (client-side, since RWS's elog endpoint has no severity query param) plus the corrected domain dropdown; confirmed live that `minSeverity=2` against domain `0` correctly cut 27 entries down to the single real warning present, with no false negatives/positives against the visible `msgtype` values.

**ASI buttons note**: the two physical buttons near the GoFa's tool flange are exposed as plain `DI` signals `Asi1Button1` / `Asi1Button2` (`GET /rw/iosystem/signals/Asi1Button{1,2}`, same `lvalue` shape as any other digital input) — readable today with `gofa-di-read` (just set Signal to the name) and subscribable with `gofa-subscribe-io`, no new node needed. This holds **even when the FlexPendant's Wizard menu has a button assigned to a function like "Add a move position"**: confirmed live that a press still produces a real `0→1→0` edge on the RWS signal (both by polling and by WS push) — Wizard reads the same signal rather than claiming it exclusively. Opens the door to a physical "teach" workflow (hand-guide via `gofa-leadthrough` (action enable), tap a button, `gofa-subscribe-io` fires a flow that calls `gofa-save-point`) without touching the FlexPendant screen — not built, just confirmed feasible.

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
dependency, `ws` stays the package's only runtime dependency. Verified **byte-for-byte** against
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

**Tool load data caution (from ABB's EGM Application Manual, not yet acted on):** the manual
states the robot must have correct tool load data (`LoadIdentify`) before starting EGM —
incorrect load data can cause servo torque overruns or safety halts when EGM issues fast
corrections. `MainModuleEGM.mod`'s `tGripper` currently declares an unverified placeholder
mass (1 kg); `LoadIdentify` has never been run against this robot's actual end-of-arm tooling.
Not hit live yet (all EGM testing so far has been small-amplitude joint corrections with no
tooling attached), but run `LoadIdentify` (or otherwise confirm `tGripper`'s load data is
accurate) before relying on EGM with real tooling mounted.

Full design history and the reasoning behind the two-module decision: see the
`project_egm_node_red_integration_plan` memory and its linked plan file.

## Nodes (43 total)

| Node | Transport | Description |
|------|-----------|-------------|
| `gofa-robot` | config | Shared config: IP, RWS port 443, socket port 1025, creds, local points file, remote (on-robot) points path. Config dialog has a **Discover** button (admin endpoint `/gofa-robot/discover` → `discover()` LAN scan, verifies ABB via WWW-Authenticate realm) |
| `gofa-setup` | RWS + Socket | One-click first-run init: preflight (must be Auto mode — RWS can't change opmode) → stop RAPID → unload conflicting MainModule/MainModuleEGM sibling → upload bundled `.mod` (SERVER_IP auto-synced) → loadmod → resetpp → motors on → start (verified by polling, HTTP 200 lies) → socket PING. Per-step `{name, ok, detail}` report; `outputPayload` defaults **true** (the report is the point). Module files read from the package's own `rapid/` dir (synced by prepack.js) |
| `gofa-status` | RWS | Reads ctrlstate, opmode, speedratio, RAPID execstate |
| `gofa-connection-status` | RWS + Socket | Checks RWS (4 calls) and the TCP socket ping independently — each failure is caught and reported per-layer instead of the whole node throwing on the first one down. Unlike `gofa-status`, a degraded/unreachable result is still a successful run (no Node-RED error raised), so it's safe to poll on a timer. |
| `gofa-pose` | RWS | Current TCP pose (x,y,z + quaternion + config flags) |
| `gofa-joints` | RWS | All 6 joint angles in degrees |
| `gofa-system-info` | RWS | RobotWare version, controller name/ID/type/MAC |
| `gofa-elog` | RWS | Controller event log entries; Domain (category, not severity) + Min Severity (info/warning+/error-only) filters |
| `gofa-motor` | RWS | Motor on/off via `POST /rw/panel/ctrl-state` |
| `gofa-move` | Socket | HOME or SETHOME |
| `gofa-movej` | Socket | Absolute joint move; Move type dropdown Joint (MoveAbsJ, default) / Linear (CalcRobT + MoveL) — displayed as "Move Joints", type id unchanged for compat |
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
| `gofa-points` | disk | Dump points list to `msg.payload` (action `export`) or **replace** it from `msg.payload`/file (action `import`) — local storage only. Bare-string payload stays a file path (NOT an action override); only `msg.payload.action` overrides |
| `gofa-sequencer` | Socket + disk/RWS | Visit saved points in order (Local `points.json` or On-Robot file); per-step dwell + move type override, loop count, ping-pong, startStep |
| `gofa-stop-seq` | Socket + in-memory | Sets `_seqStop` flag and sends immediate `STOP` socket command |
| `gofa-rapid-exec` | RWS | Start/stop/resetPP/loadmod/unloadmod/activate RAPID program *(requires Remote Start/Stop UAS grants; resetpp/loadmod/unloadmod/activate need Edit mastership, granted automatically)* |
| `gofa-rapid-var-read` | Socket | Read a RAPID PERS variable via `GETVAR:<name>` socket command |
| `gofa-rapid-var-write` | Socket | Write a RAPID PERS variable via `SETVAR:<name>:<value>` socket command |
| `gofa-rapid-tasks` | RWS | List RAPID tasks and the modules loaded in one of them |
| `gofa-file` | RWS | Controller filesystem: action `download` / `upload` / `delete` (delete is new in 2.0.0, uses the fileservice DELETE confirmed live 2026-07-15). Upload auto-syncs `SERVER_IP` to the config node's IP (`patchServerIp`, now in `nodes/lib/patch-server-ip.js`, no-ops on files without the constant). Bare-string payload = remotePath for download/delete, localPath for upload |
| `gofa-mod-edit` | RWS | Edit a controller-disk file in the node's edit dialog: file dropdown ($HOME/Programs, admin endpoint `/gofa-mod-edit/:id/files`) or new filename, ace editor, Load/Save-to-robot buttons (SERVER_IP auto-synced on save); runtime input re-uploads stored content. Directory-listing parse (`parseFileList`) **confirmed live 2026-07-15**: entries are `<li class="fs-file" title="<name>">` (name in the `title` attr — the parser's first-choice path; the anchors carry the name only in `href`, with empty text), plus `fs-cdate`/`fs-mdate`/`fs-size`/`fs-readonly` spans. `fs-dir` shape still unobserved (no subdirs existed). Also confirmed live: fileservice `DELETE /fileservice/<path>` works (`204`, then `404` on GET) — first confirmed RWS file-delete in this project |
| `gofa-io-list` | RWS | List all I/O signals |
| `gofa-di-read` | RWS | Read digital input |
| `gofa-do-write` | RWS or Socket | Write digital output; Transport dropdown — RWS `/set-value` (needs `Access: All`) or Socket `SETDO` (needs RAPID running, no Access Level restriction) |
| `gofa-leadthrough` | Socket + RWS | Hand-guiding: action `enable` (sends socket STOP first to clear queued moves, tolerates socket-down) / `disable` (RWS only) |
| `gofa-asi-led` | Socket | Set ASI status light RGB color + counted software blink via `SETLED` / `RESETLED` |
| `gofa-subscribe-state` | RWS WS | Push on every controller state change; one-shot mode polls once per inject |
| `gofa-subscribe-io` | RWS WS | Push on every I/O signal change (real WebSocket push, confirmed live down to a single button tap); falls back to 500 ms polling only if the subscribe request itself fails; one-shot mode available |
| `gofa-subscribe-var` | RWS poll | Poll a RAPID variable on an interval; toggles on/off per inject |
| `gofa-subscribe-pose` | RWS poll | Poll TCP position on an interval; toggles on/off per inject |
| `gofa-subscribe-elog` | RWS WS | Push new controller event log entries in real time (bare `/rw/elog/<domain>` subscription — no `;suffix`, unlike other subscribe nodes; the push only carries a `seqnum` reference, so the node fetches the full entry before emitting); same Domain + Min Severity filters as `gofa-elog` |
| `gofa-egm` | Socket + UDP (EGM) | Session control + telemetry — Action dropdown (start/stop) sends `EGMJOINT`/graceful-stop signal, holds pose, emits throttled feedback. Requires `MainModuleEGM.mod` loaded, not the default `MainModule.mod` — see EGM section above |
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

**Rule — every `.mod` edit must be synced into the npm package copy, same commit.**
`rapid/*.mod` (repo root) is the source of truth; `node-red-contrib-abb-gofa/rapid/*.mod` is
the copy that ships on npm **and the one `gofa-setup` reads at runtime** — a stale package copy
means one-click setup installs outdated RAPID code on a dev/git install (prepack.js only
re-syncs at `npm pack`/publish time, not on commit). After editing any root `rapid/*.mod`, copy
it to `node-red-contrib-abb-gofa/rapid/` (or run `node prepack.js` from the package dir).
Enforced: `test.js` has a byte-for-byte drift check that fails the suite if the copies differ.

**On continuity across machines**: this project's Claude Code memory (hard-won lessons, decisions,
live-test history) normally lives outside the repo, keyed to the local clone's working-directory
path — it doesn't travel when this repo is cloned elsewhere. `.claude/memory/` and `.claude/plans/`
are manually-copied snapshots of that history, committed to the repo so a fresh clone (new
machine, or anyone else picking this up) starts with the same context instead of from zero. They
go stale the moment new memory accumulates outside them — worth re-syncing periodically, not just
once. Start any "what's the history here" question with `.claude/memory/MEMORY.md`.
