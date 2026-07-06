# ABB Robot Web Services (RWS) API Reference

Source: https://developercenter.robotstudio.com/api/rwsApi/index.html  
Applies to: OmniCore C30 controller, RobotWare 7.x

---

## Development workflow: verify before building

When implementing or changing anything that talks to the real robot — a new RWS endpoint,
a new RAPID socket command, a fix to how one is called — **always work in this order**:

1. **Look for the right command first.** Curl the RWS endpoint (or send the raw socket
   command, e.g. via a PowerShell `TcpClient` one-off) against the live controller
   (`192.168.20.33`) before writing any node code. Confirm it exists, confirm the response
   shape, confirm it behaves the way you're about to assume it does. Don't trust a
   remembered/documented path blindly — this OmniCore (RWS 2.0) controller diverges from the
   general RWS reference in several confirmed places (path-based vs query-based actions;
   `symbols` vs `symbol`). A handful of well-motivated path variants is a reasonable effort if
   the first attempt fails; don't guess indefinitely — report a negative result rather than
   building on an unverified foundation.
2. **Only build once step 1 succeeds.** If the live test fails, stop and report the finding
   (with the actual error/response) instead of writing a node around behavior you haven't
   confirmed.
3. **After building, test again — against the real robot, not just mocks.** Mocked unit tests
   prove the code does what you told it to do; they can't catch a wrong assumption about what
   RWS/RAPID actually returns. Re-run the finished node's logic (not just curl) against the
   live controller before calling the work done.
4. **When you explain *why* something failed, verify the explanation too — don't just
   pattern-match a plausible-sounding cause.** A 404 doesn't announce its own root cause. This
   file used to claim the generic RAPID symbol endpoint needed a "PC Interface" RobotWare
   option — that was copied from an old, never-verified code comment, stated as fact, and was
   wrong on every level (wrong option name for OmniCore, wrong subsystem entirely — see the
   corrected note under `GET /rw/rapid/tasks/{task}/modules`). It only got caught because the
   user pushed back and asked for real evidence. Cite an actual source (official manual, the
   controller's own response, a confirmed working example) before writing a root-cause claim
   into project docs — not just "it 404'd, so it's probably X."

This is the process that caught `gofa-rapid-exec`'s motors-off false-success bug, confirmed
`gofa-rapid-tasks` works, and — after initially getting the *reason* wrong — correctly
diagnosed why a generic RWS variable-write node doesn't (yet) work here.

---

## Base URL & Transport

```
http://{controller-ip}/rw/     (default port 80)
https://{controller-ip}/rw/    (port 443 — used in this project)
```

All paths below are relative to the controller root (not `/rw/`).

---

## Authentication

**Method**: HTTP Digest Authentication (or Basic — this project uses Basic)  
**Flow**:
1. First request → controller returns `401 Unauthorized`
2. Client re-sends with `Authorization: Basic base64(user:pass)` header
3. Controller returns `set-cookie: ABBCX=...; http-session=...`
4. All subsequent requests send the cookies instead of credentials
5. On next `401`, clear cookie and repeat from step 2

**Session limits**:
- Max 70 sessions total (19 with WebSocket subscriptions active)
- Max 2 HTTP connections + 1 WebSocket per session
- Max 15 connections per IP
- InactivityTimeout: 5 minutes
- Logout: `GET /logout`

---

## Request / Response Format

**Default response**: XHTML (XML), UTF-8  
**JSON**: append `?json=1` to any GET (follows HAL spec)  
**POST body**: `application/x-www-form-urlencoded;v=2.0`  
**Accept header**: `application/xhtml+xml;v=2.0`  

**Parsing responses** (XHTML): values are in `<span class="{classname}">value</span>` elements.  
The `parseXhtml(body, className)` helper in this project uses a regex to extract these.

---

## HTTP Methods

| Method | Use |
|--------|-----|
| GET    | Read resource (no state change) |
| POST   | Update/action on resource |
| PUT    | Create or replace resource |
| DELETE | Remove resource |

---

## Endpoints Used in This Project

### Panel Service — `/rw/panel/`

#### GET /rw/panel/ctrl-state
Read controller state.  
Response class: `ctrlstate`  
Values: `motoron` | `motoroff` | `guardstop` | `emergencystop` | `emergencystopreset` | `sysfail`

#### GET /rw/panel/opmode
Read operating mode.  
Response class: `opmode`  
Values: `auto` | `manualreduced` | `manualfull`

> **Casing note:** confirmed live on this controller that `opmode` actually returns **`AUTO`
> (uppercase)**, not the lowercase `auto` shown above (which matches the general RWS
> documentation) — `ctrlstate` and `ctrlexecstate` do come back lowercase (`motoron`,
> `running`/`stopped`) as documented, so this is specific to `opmode`. Caught by curling the
> live endpoint before wiring a case-sensitive comparison into a flow — compare
> case-insensitively (e.g. JSONata `$lowercase(payload.opmode) = "auto"`) rather than trusting
> the documented casing.

#### GET /rw/panel/speedratio
Read current speed override percentage.  
Response class: `speedratio`  
Values: integer 0–100

#### POST /rw/panel/speedratio
Set speed override percentage. **Requires mastership.**  
Flow: `POST /rw/mastership/request` → `POST /rw/panel/speedratio` → `POST /rw/mastership/release`  
Body: `speed-ratio=<1-100>` (NOT `speed=`, NOT `speedratio=`)  
Returns: `204 No Content` on success

#### POST /rw/panel/ctrl-state
Set motor state.  
Body: `ctrl-state=motoron` or `ctrl-state=motoroff`  
Returns: `204 No Content` on success

---

### Mastership — `/rw/mastership/`

**OmniCore has two mastership domains — they are independent:**

#### General mastership (motion domain)
```
POST /rw/mastership/request   — always blocked on OmniCore (HTTP 403 org_code:-13)
POST /rw/mastership/release
```
On OmniCore, the RAPID runtime holds motion mastership internally at all times (even when RAPID is stopped). `POST /rw/mastership/request` will always return 403. Do not use this for `resetpp` or RAPID var writes.

#### Edit mastership
```
POST /rw/mastership/edit/request   — acquire edit mastership (204 on success)
POST /rw/mastership/edit/release   — release edit mastership (204 on success)
```
Edit mastership is a separate domain from motion mastership. It works even while RAPID is running or stopped.

**Required for:**
- `POST /rw/rapid/execution/resetpp`
- RAPID variable writes (`PUT /rw/rapid/symbol/data/...`)

**Not required for:**
- `start` / `stop` (need UAS grants instead)
- Motor on/off (`ctrl-state`)
- Read-only RWS calls
- I/O reads

The palette uses `GoFaRobotNode.prototype.withMastership(fn)`, hardcoded to the `edit` domain (general mastership is always blocked on OmniCore, so there's no other domain to parameterize). Always release in both success and error handlers.

---

### RAPID Service — `/rw/rapid/`

#### GET /rw/rapid/execution
Read RAPID execution state.  
Response class: `ctrlexecstate`  
Values: `running` | `stopped`

#### POST /rw/rapid/execution/start
Start RAPID program execution.  
Body: `regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false`  
Returns: `204 No Content`  
**Requires: Remote Start UAS grant** (set in RobotStudio → Edit User Accounts). Not mastership.  
Error `icode:-757` = user lacks Remote Start grant.

#### POST /rw/rapid/execution/stop
Stop RAPID program execution.  
Body: `stopmode=stop&usetsp=normal`  
Returns: `204 No Content`  
**Requires: Remote Stop UAS grant.**  
Error `icode:-757` = user lacks Remote Stop grant.

#### POST /rw/rapid/execution/resetpp
Reset program pointer to main.  
Body: (empty)  
Returns: `204 No Content`  
**Requires: edit mastership** (`POST /rw/mastership/edit/request` first).  
Error `org_code:-4501` = edit mastership not held.

> **OmniCore note:** All three use **path-based** URLs (RWS 2.0). The IRC5 format `POST /rw/rapid/execution?action=start` returns **HTTP 405** on OmniCore.

#### GET /rw/rapid/tasks
List every RAPID task on the controller.  
Response: one `<li class="rap-task-li">` per task, with span classes `name`, `type` (normal/semistatic), `taskstate`, `excstate` (started/stopped), and — for the main motion task only — `active`, `motiontask`.  
No mastership required. On a GoFa 12, expect more than just your program's task — e.g. built-in `SC_CBC` and an ASI-LED-handling task alongside `T_ROB1`.

#### GET /rw/rapid/tasks/{task}/modules
List modules loaded in a task.  
Response: one `<li class="rap-module-info-li">` per module, with span classes `name`, `type` (`ProgMod` = your program module, `SysMod` = system/installed module).  
No mastership required. This is the closest RWS equivalent to "what program is loaded" — RAPID doesn't have a single-file "program" concept, just a task's set of loaded modules.

> **Load/reload a module into a task ("Load Module" on the FlexPendant) — works over RWS, but not at the documented query-action path.** Confirmed live against `T_ROB1` on RobotWare 7.21.0+229:
> - `POST /rw/rapid/tasks/T_ROB1?action=loadmod` (ABB's documented RWS 1.0/IRC5 task-load action, body `modulefilepath`+`replace`) → `405 Method Not Allowed` — despite `OPTIONS` on that exact resource reporting `Allow: GET,POST,OPTIONS`. Same red-herring `Allow` header as `/rw/rapid/symbols` above; the POST that resource actually accepts is for `/subscription` (confirmed via the `OPTIONS` response body, which only lists `sub-subscribe` forms), not `loadmod`. `action=load`/`action=unloadmod` name variants, and POSTing to the `.../modules` or `.../modules/{module}` sub-resources, all fail the same way or report `Allow: GET,OPTIONS`.
> - The real endpoint is **path-based, not query-action**: `POST /rw/rapid/tasks/{task}/loadmod`, body `modulepath=<path>&replace=true|false`. It also needs `Accept: application/hal+json;v=2.0` — the one resource in this whole project that rejects the `xhtml+xml` Accept header every other endpoint uses ("Server cannot generate response for given accept header"). Gated on edit mastership (`POST /rw/mastership/edit/request` first, same as `resetpp`).
> - Verified end to end with a single shared cookie session: request mastership (`204`) → `POST /rw/rapid/tasks/T_ROB1/loadmod` with `modulepath=$HOME/Programs/MainModule.mod&replace=true` → `200`, body `{"state":[{"_type":"rap-task-module-li","name":"MainModule"}]}` → release mastership (`204`), confirmed via `GET /rw/mastership/edit` → `nomaster`. No side effects — `ctrlexecstate` unchanged (`stopped`) before and after.
> - A companion action, `POST /rw/rapid/tasks/{task}/activate` (body `module=<name>`), also confirmed working the same way (mastership-gated, `204`).
> - **Both `loadmod` and `activate` require RAPID to be stopped.** Confirmed live in both directions on the same call: with `ctrlexecstate: stopped` → `204`/`200` success; with `ctrlexecstate: running` → `403`, body `{"status":{"code":-1073442809,"msg":"rws_resource_rapid_task.cpp[...]: Operation not allowed for current PGM state (Started/Stopped/Ready)"}}`. This body detail was previously invisible to callers — `gofa-robot.js`'s `request()` only threw `HTTP <code> <path>`, discarding the response body entirely; it now extracts the `msg` field (xhtml `<span class="msg">` or hal+json `"msg":"..."`) and appends it to the thrown error for every RWS call in this palette, not just these two.
>
> `gofa-rapid-exec` has both `loadmod` and `activate` actions, both wrapping the path-based form above (`gofa-robot.js`'s `rwsPostHal()` sends the hal+json Accept header). This closes the gap where `gofa-upload-mod` only replaces the file on disk — `loadmod` makes the running task actually pick up the new content, no FlexPendant needed. The node adds a specific hint ("RAPID must be stopped for loadmod/activate — stop it first") when it detects this exact rejection. Still requires a separate `resetpp` (already a `gofa-rapid-exec` action) if the program pointer also needs resetting to Main before `start`.

> **Generic RAPID symbol data — 404s on OmniCore, root cause is NOT licensing (corrected below).**
>
> `GET`/`PUT /rw/rapid/symbol/data/RAPID/{task}/{module}/{symbol}` is the documented (RWS 1.0 / IRC5-era) generic way to read/write any RAPID variable. On this OmniCore C30 controller it returns `404 SYS_CTRL_E_UNRESOLVED_URL` for every path variant tried. **An earlier version of this note wrongly blamed a missing "PC Interface" RobotWare option — that was unverified guesswork copied from an old code comment, and it's flatly wrong.** Verified against ABB's own OmniCore C-line product manual (3HAC065034-001): "Robot web services" is listed as a *standard, base-included* RobotWare communications technology (same section as socket messaging, no option/license attached). The actual OmniCore option in this space, **RobotStudio Connect [3119-1]**, is about letting the *RobotStudio desktop app* connect over a public/WAN interface — completely unrelated to the RWS REST API.
>
> **What's actually going on:** `GET /rw/rapid` on this controller advertises a `symbols` resource — **plural**, not the singular `symbol` from the endpoint above. This is the same RWS 1.0 (IRC5) vs RWS 2.0 (OmniCore) naming/shape split already documented elsewhere in this file (`execution?action=start` → `execution/start`, IO `?action=set` → `/set`). `/rw/rapid/symbols` is real and implemented (confirmed via its error messages referencing live server source files `rws_resource_rapid_symbols.cpp` / `rws_resource_rapid_module.cpp`, not a stub) — but it's a **search-based** resource (`?action=search-symbols` with `view`/`blockurl`/`regexp`/`posl`/`posc` filters per ABB's docs), not a flat GET-by-name path. Attempts so far and their results:
> - `GET /rw/rapid/symbols` (with or without any query string, incl. `?action=search-symbols` + full param set) → always **200, empty state** — GET on this resource appears to silently ignore all query params rather than executing a search; self-link in the response never echoes them back
> - `POST /rw/rapid/symbols?action=search-symbols` (params in query string, body has `view`/`blockurl`/`regexp`/etc) → **405 Method Not Allowed**
> - `POST /rw/rapid/symbols` (no query string at all, `action=search-symbols` as just another body field alongside `view`/`blockurl`/`regexp`) → **405 Method Not Allowed** — same result regardless of where `action` lives, so it isn't a query-vs-body placement issue
> - `POST /rw/rapid/symbols/search-symbols` (path-based action, no query) → **404** — not the right path shape either
> - `GET /rw/rapid/tasks/{task}/modules/{module}/symbol?view=...&posl=...&posc=...` (module-scoped sibling resource, distinct from the root `symbols`) → 200 but always empty, params silently ignored — likely a code-position-scoped browser (for an editor's "what's in scope at line X, col Y", per `posl`/`posc` naming) rather than a name search
>
> Since POST is rejected at `/rw/rapid/symbols` itself no matter how the action is expressed, the real invocation almost certainly lives at a different path entirely that hasn't been found yet (not a parameter-encoding problem at the paths tried).
>
> **Status: CONFIRMED IMPOSSIBLE on this controller (RobotWare 7.21.0+229) — exhaustively re-verified, not just unresolved.** A later session re-tested this from scratch by fetching ABB's own current Developer Center pages for the exact, official call shape — not a remembered/guessed path — and reproducing their example verbatim against the live robot (`GET /rw/system` confirmed `rwversion: 7.21.0+229` at test time):
> - `GET /rw/rapid/symbol/data/RAPID/T_ROB1/MainModule/nTestVar` (ABB's documented read path, exact syntax from `rapid_symbol_data_get_page.html`) → `404`, `rws_services.cpp: Resource not found` — and `GET /rw/rapid`'s own resource listing confirms no `symbol` (singular) link exists at all on this controller, only `symbols` (plural). Router-level absence, not a wrong parameter.
> - `POST /rw/rapid/symbols?action=search-symbols` with the full documented form body (from `rapid_symbols_properties_page_actions_get.html`, ABB's own curl example reproduced verbatim) → `405 Method Not Allowed`, `rws_resource.cpp: HTTP method not supported by resource` — despite the response's own `Allow: GET,POST,OPTIONS` header claiming POST is valid on this resource
> - Singular `action=search-symbol` and path-based `/rw/rapid/symbols/search-symbols` variants → `405` / `404` respectively, ruling out an action-name or query-vs-path guess
> - `GET /rw/rapid/symbols?action=search-symbols` with every param in the query string → `200` but silently empty, ignoring all params (matches the earlier finding, now confirmed with the *exact* documented param set, not a partial one)
> - Module-scoped `GET /rw/rapid/tasks/T_ROB1/modules/MainModule/symbol?posl=0&posc=0` → `200` but empty `<ul></ul>` — confirmed to be a code-position browser (line/column, for an editor's "what's in scope here"), not a name-based lookup, regardless of what params are added
>
> This project's `gofa-rapid-var-read`/`gofa-rapid-var-write` nodes use the custom TCP `GETVAR:`/`SETVAR:` protocol instead — proven and simple, not a workaround for a missing option. See the `omnicore-c30` skill for the RobotStudio Connect / Multitasking option findings that debunked the original licensing claim. **Do not build a generic RWS variable node** — this has now been tested with ABB's own current official syntax, not an assumption, and it does not work on this controller/firmware. Re-open only if a future RobotWare update is confirmed (via changelog or a fresh live test) to change this behavior.

#### Remote Start/Stop — UAS grants (not RMMP)

To start/stop RAPID via RWS, the RWS user needs UAS grants, not RMMP privileges:
- `POST /users/rmmp` with `privilege=modify` → HTTP 403 `icode:-4502` — wrong mechanism
- Built-in `Admin` account cannot start/stop RAPID remotely regardless of RMMP
- Correct: create a user in **RobotStudio → Edit User Accounts** with **Remote Start** + **Remote Stop** grants
- In RobotWare 7, UAS management is in RobotStudio only (not on FlexPendant)

---

### Motion System — `/rw/motionsystem/`

#### GET /rw/motionsystem/mechunits/{unit}/robtarget
Read current TCP pose (robtarget) of a mechanical unit.  
Unit for GoFa: `ROB_1`  

Query parameters:
| Param | Example | Description |
|-------|---------|-------------|
| `tool` | `tool0` | Tool frame to use |
| `wobj` | `wobj0` | Work object frame |
| `coordinate` | `Base` | Coordinate system: `Base`, `World`, `Tool`, `Wobj` |

Full URL used in project:
```
GET /rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base
```

Response classes: `x` `y` `z` (mm) | `q1` `q2` `q3` `q4` (quaternion) | `cf1` `cf4` `cf6` `cfx` (robot config)

#### GET /rw/motionsystem/mechunits/{unit}/jointtarget
Read current joint angles of a mechanical unit.  
Unit for GoFa: `ROB_1`  

Response classes: `rax_1` `rax_2` `rax_3` `rax_4` `rax_5` `rax_6` (degrees)

> **Live TCP pose is NOT subscribable over RWS — polling is the only option.** Investigated converting `gofa-subscribe-pose` from 500ms polling to WS push (the same mechanism already proven solid for `gofa-subscribe-io`/`gofa-subscribe-state`). Confirmed on this controller (RobotWare 7.21.0+229):
> - `OPTIONS /rw/motionsystem/mechunits/ROB_1/robtarget` → `Allow: GET,OPTIONS` only, no subscribe form in the body (unlike IO signals and tasks, which list a `sub-subscribe` form).
> - `POST /subscription` naming that resource, tried with 7 different suffix guesses (`;robtarget`, `;state`, `;value`, `;position`, `;cartesian`, `;ms-robtargets`, no suffix) → **every one timed out** (server never responds), not a fast reject like a wrong-but-plausible suffix normally gets (compare the IO-signal `;lvalue` mistake, which got an immediate `400`). A parallel sanity-check subscribing to `/rw/panel/ctrl-state;ctrlstate` in the same run succeeded instantly (`201`), confirming the subscription mechanism itself was healthy — the hang is specific to naming a motion resource.
> - The mechunit resource one level up, `/rw/motionsystem/mechunits/ROB_1`, *does* have a `sub-subscribe` form — but the resource it offers is `/rw/motionsystem/mechunits;mechunitmodechangecount`, a counter that increments on mechanical-unit **mode** changes (e.g. independent/normal), not a position stream. `/rw/motionsystem/mechunits/ROB_1/jointtarget` and the `/rw/motionsystem` root both come back `Allow: GET,OPTIONS`, no subscribe form either.
>
> **Conclusion: continuous Cartesian/joint position isn't exposed through RWS's event/subscription system on this controller** — that system covers discrete state-change events (IO transitions, task state, mechunit mode), not continuously-varying telemetry. ABB's answer for that use case is a separate real-time channel (EGM — Externally Guided Motion, UDP-based), not RWS. **`gofa-subscribe-pose` should stay on polling** — this isn't a bug or a missing param, it's what the resource actually supports.

---

### System Service

#### GET /rw/system
Used in this project to establish/verify session (triggers the 401→auth flow).

---

### File Service

Manages files on the controller filesystem.

#### PUT /fileservice/{path}
Upload a file.  
Headers: `Content-Type: text/plain;v=2.0`  
Body: file content (binary or text)

Example (from README):
```bash
curl -sk -u Admin:robotics -X PUT -H "Content-Type: text/plain;v=2.0" \
  --data-binary @rapid/MainModule.mod \
  "https://{ROBOT_IP}/fileservice/$HOME/Programs/MainModule.mod"
```

---

### Subscription Service — `/subscription`

Real-time event delivery over WebSocket (RFC 6455).  
Subprotocol: `rws_subscription` (OmniCore RW7 — `robapi2_subscription` returns HTTP 400)

#### POST /subscription
Create a subscription.  
Body (form-encoded): `resources={id}&{id}={resource-path}&{id}-p={priority}`

Priority levels:
| Value | Name | Max delay |
|-------|------|-----------|
| `0` | Low | 5 seconds |
| `1` | Medium | 200ms |
| `2` | High | Immediate (IO signals and RAPID variables only) |

Limits: 1000 resources (low/medium), 64 resources (high priority)

**`{resource-path}` suffix is a fixed per-resource keyword, not the value's own attribute name.**
It's tempting to build `{resource-path}` as `{GET path};{class-name-from-the-GET-response}`, but
that's wrong — each RWS resource defines its own resource-type keyword for subscriptions,
independent of what a plain GET happens to name the value:

| Resource | GET returns value in class | Correct subscription suffix |
|----------|------------------------------|------------------------------|
| `/rw/panel/ctrl-state` | `ctrlstate` | `;ctrlstate` (same name here, coincidentally) |
| `/rw/iosystem/signals/{name}` | `lvalue` | `;state` (**not** `;lvalue`) |

Confirmed live on this OmniCore controller: `POST /subscription` with resource
`/rw/iosystem/signals/{name};lvalue` returns `400 Invalid resource URI in Create Subscription
request` for **every** signal tried — a top-level one (`GOFA_MotorsOn`) and a device-scoped one
(`Asi1Button2`) both 400 with that suffix and both succeed (`201`) with `;state` instead, same
path otherwise. The push event body then names the value `class="lvalue"` again (e.g.
`<li class="ios-signalstate-ev"><span class="lvalue">1</span>...`) — so the GET attribute name
and the subscription keyword are simply two different things for this resource. Don't assume
the pattern from one working resource (`ctrlstate`) generalizes to another (`iosystem/signals`)
without testing live — this exact assumption caused `gofa-subscribe-io` to silently fall back to
polling on every signal for a while (see the "IO subscription note" in the top-level CLAUDE.md).

#### PUT /subscription/{id}
Update subscription resource list.

#### DELETE /subscription/{id}
Unsubscribe.

WebSocket keepalive: send ping every 30s, expect pong within 1s.

---

### Progress (Async Operations)

Some operations return `202 Accepted` with a `Location: /progress/{id}` header.

#### GET /progress/{id}
Poll async operation status.  
States: `PENDING` | `IN_PROGRESS` | `DONE` | `FAILED`

---

## Error Handling

- HTTP 2xx = success (204 = no body)
- HTTP 4xx/5xx = error with XML/JSON body containing:
  - `<span class="code">` — internal error code
  - `<span class="msg">` — description and stack trace
- Look up error codes: `GET /rw/retcode?code={error-code}`

---

## Performance Guidelines

| Metric | Value |
|--------|-------|
| Typical response time | < 50ms |
| Recommended request rate | ≤ 20 req/s (50ms interval) |
| Max input payload | < 100KB (except file upload) |
| Max file upload | 800MB |

---

## Lead-Through — `/rw/motionsystem/mechunits/{unit}/lead-through`

#### GET /rw/motionsystem/mechunits/ROB_1/lead-through
Read lead-through state.  
Response class: `status`  
Values: `Active` | `Inactive`

#### POST /rw/motionsystem/mechunits/ROB_1/lead-through
Enable or disable lead-through (compliance/hand-guiding) mode.  
Works in **Auto mode with RAPID stopped and motors ON**.  
Body: `status=active` (enable) or `status=inactive` (disable)  
Returns: `204 No Content`

> **OmniCore note:** Sub-paths `/lead-through/activate` and `/lead-through/deactivate` do **not** exist — they return HTTP 404. Use the base resource with the `status` body parameter for both directions.

---

## I/O Service — `/rw/iosystem/`

#### POST /rw/iosystem/signals/{name}/set
Set an I/O signal value.  
Body: `lvalue=<value>` (0 or 1 for digital, float for analog)  
Returns: `204 No Content`  
> OmniCore path-based format. IRC5 format (`?action=set`) returns HTTP 405.

---

## Notes for This Project

- Controller IP: `192.168.20.33`, credentials: `NNNN:robotics`
- `rejectUnauthorized: false` is set in all HTTPS requests (self-signed cert on controller)
- The project uses Basic auth (not Digest) on first request, then cookie for subsequent requests
- Cookie is stored in `robot._cookie` on the config node and cleared on 401
- All RWS calls go through `robot.rwsGet()` / `robot.rwsPost()` helpers in `gofa-robot.js`
- Response parsing uses `robot.parseXhtml(body, className)` — regex-based, not a DOM parser
- `withMastership(fn)` uses edit domain (`/rw/mastership/edit/...`), not general mastership

---

## Node msg.payload Pattern

All palette nodes follow: **msg.payload → node property (editor) → built-in default**

**Nodes fixed to add bare-string payload support (previously only accepted object form):**

| Node | Bare string accepted | Object form |
|------|---------------------|-------------|
| `gofa-motor` | `'motoron'` / `'motoroff'` | `{ action: 'motoron' }` |
| `gofa-move` | `'HOME'` / `'SETHOME'` | `{ command: 'HOME' }` |
| `gofa-rapid-exec` | `'start'` / `'stop'` / `'resetpp'` | `{ action: 'start' }` |

**Nodes fixed to read file path from msg.payload (previously used non-standard msg.* keys):**

| Node | msg.payload string | msg.payload object | Legacy fallback |
|------|-------------------|--------------------|-----------------|
| `gofa-points-export` | save path | `{ savePath: '...' }` | `msg.savePath` |
| `gofa-points-import` | load path | `{ loadPath: '...' }` or array | `msg.loadPath` |

**Node fixed to support runtime interval override:**

| Node | msg.payload on start | Effect |
|------|---------------------|--------|
| `gofa-subscribe-pose` | `{ interval: 2000 }` | Sets poll rate in ms (min 100); ignored on stop |
