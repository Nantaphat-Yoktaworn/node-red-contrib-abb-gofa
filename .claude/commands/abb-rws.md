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

Mastership gates write access to panel resources (speedratio) and RAPID symbol writes.

```
POST /rw/mastership/request   — acquire mastership (204 on success)
POST /rw/mastership/release   — release mastership (204 on success)
```

**Notes**:
- `/rw/mastership/edit` and `/rw/mastership/motion` paths exist but do NOT accept POST — they return "wrong uri". Use the bare `request`/`release` paths above.
- Mastership is session-scoped; always release in an error handler too.
- Not required for: I/O reads, panel ctrl-state, session management.

---

### RAPID Service — `/rw/rapid/`

#### GET /rw/rapid/execution
Read RAPID execution state.  
Response class: `ctrlexecstate`  
Values: `running` | `stopped`

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
Subprotocol: `robapi2_subscription`

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

## Notes for This Project

- `rejectUnauthorized: false` is set in all HTTPS requests (self-signed cert on controller)
- The project uses Basic auth (not Digest) on first request, then cookie for subsequent requests
- Cookie is stored in `robot._cookie` on the config node and cleared on 401
- All RWS calls go through `robot.rwsGet()` / `robot.rwsPost()` helpers in `gofa-robot.js`
- Response parsing uses `robot.parseXhtml(body, className)` — regex-based, not a DOM parser
