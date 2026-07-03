# ABB Robot Web Services (RWS) API Reference

Source: https://developercenter.robotstudio.com/api/rwsApi/index.html  
Applies to: OmniCore C30 controller, RobotWare 7.x

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
