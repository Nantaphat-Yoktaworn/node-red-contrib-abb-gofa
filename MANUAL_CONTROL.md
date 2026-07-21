# Manual Robot Control (No Node-RED)

Every command below is what the palette's own nodes actually send — copied from the
source in `node-red-contrib-abb-gofa/nodes/`, not re-derived — so you can control or
inspect the robot directly with `curl` / a raw TCP client, for debugging, scripting,
or when Node-RED itself isn't available.

Replace `<ROBOT_IP>` with the controller's current IP (`192.168.1.103` as of 2026-07-16 —
see the `SERVER_IP` note in `CLAUDE.md`; it drifts often, including whole-subnet changes,
so re-check with `check-status.js` or the `/robot-status` skill before trusting this value)
and `<username>`/`<password>` with your RWS credentials.

## The one thing that decides which half of this doc you need

| | Availability |
|---|---|
| **Part A — RWS (HTTPS, port 443)** | Works whenever the controller is powered on and reachable — RAPID does **not** need to be running. Two specific actions (`loadmod`, `activate`) are the exception: see the callout below. |
| **Part B — TCP Socket (port 1025, `T_ROB1`/`MainModule.mod`)** | Only works while **RAPID is actually executing** `MainModule.mod`'s `main()` loop — that loop is what opens the socket server. If RAPID is stopped, every socket command (even `PING`) times out. This is expected, not a bug (`check-status.js` reports it as `Socket: ERROR (socket timeout)` whenever `RAPID: stopped`). |
| **Part C — TCP Socket (port 1026, `T_LED`/`BackgroundLed.mod`)** | Runs in its own `SEMISTATIC` RAPID task, separate from `T_ROB1` — keeps working even while `T_ROB1`/`MainModule.mod` is stopped. Only supports `ping`/`setled`/`resetled`/`setdo` — see below. Requires the one-time RobotStudio task setup described in `README.md`'s ["Background task" section](README.md#background-task-backgroundledmod--t_led). |

So: status/telemetry/motor-on/upload-a-file/start-RAPID all work over RWS with RAPID
stopped. Anything that **moves the robot or reads/writes a `PERS` variable** needs
`T_ROB1` running first (Part B) — chicken-and-egg only for the very first `start`,
which is itself a Part A (RWS) command. The ASI LED and digital outputs (`setdo`) are
the exception: they also work over Part C's separate port **without** `T_ROB1` running,
via `T_LED`/`BackgroundLed.mod` — see Part C below.

---

## Part A — RWS (HTTPS) commands

All of these use Basic auth per-request (`-u user:pass`), which is simplest for
one-off manual commands — the palette normally upgrades to a session cookie after
the first call, but re-sending Basic auth every time works fine too and needs no
cookie jar. `-k` skips certificate validation (the controller's cert is self-signed;
the palette runs with `rejectUnauthorized: false` for the same reason).

### Read-only (safe anytime, no mastership needed)

```bash
IP=<ROBOT_IP>
AUTH="-u <username>:<password>"
ACCEPT='-H "Accept: application/xhtml+xml;v=2.0"'

# Controller state: motoron / motoroff / guardstop / emergencystop
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/panel/ctrl-state"

# Operating mode: AUTO / manualreduced / manualfull
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/panel/opmode"

# FlexPendant/production-window speed override, 0-100 (a SEPARATE value from the
# socket SPEED/GETSPEED commands below, which use RAPID's VelSet instead — see CLAUDE.md)
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/panel/speedratio"

# RAPID execution state: running / stopped
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/rapid/execution"

# Current TCP pose (x,y,z mm + quaternion + robot config)
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" \
  "https://$IP/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base"

# Current joint angles (degrees)
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" \
  "https://$IP/rw/motionsystem/mechunits/ROB_1/jointtarget"

# RobotWare version
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/system"

# Controller name/ID/MAC
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/ctrl/identity"

# Event log — domain 1 ("Common"), last 5 entries
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/elog/1?lang=en&lim=5"

# List every I/O signal
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/iosystem/signals"

# Read one digital or analog input/output by name (same endpoint for all signal types)
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/iosystem/signals/<SIGNAL_NAME>"

# List RAPID tasks on the controller
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/rapid/tasks"

# List modules loaded in a task
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/rapid/tasks/T_ROB1/modules"

# Download a file from the controller (e.g. the running MainModule.mod)
curl -sk $AUTH -H "Accept: */*" "https://$IP/fileservice/\$HOME/Programs/MainModule.mod"

# Read the on-robot saved-points file (gofa-save-point/etc's "Storage: On-Robot" mode)
# — a 404 here just means no points have been saved on-robot yet
curl -sk $AUTH -H "Accept: */*" "https://$IP/fileservice/\$HOME/Programs/gofa_points.json"

# Check who (if anyone) currently holds edit mastership -- not sent automatically by
# any node, just a useful manual read while debugging a stuck lock
curl -sk $AUTH -H "Accept: application/xhtml+xml;v=2.0" "https://$IP/rw/mastership/edit"
```

### Write, no mastership needed

```bash
IP=<ROBOT_IP>
AUTH="-u <username>:<password>"
CT='application/x-www-form-urlencoded;v=2.0'

# Motors on / off
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "ctrl-state=motoron"  "https://$IP/rw/panel/ctrl-state"
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "ctrl-state=motoroff" "https://$IP/rw/panel/ctrl-state"

# Write a digital or analog output (0/1 for digital, a float for analog)
# Needs the signal's Access Level set to All (RobotStudio, restart required) — the
# IRC5-era `/set` path 405s unconditionally on this OmniCore/RWS 2.0 controller.
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "lvalue=1" "https://$IP/rw/iosystem/signals/<SIGNAL_NAME>/set-value"

# Start RAPID — requires Remote Start UAS grant, AUTO mode, motors on
curl -sk $AUTH -H "Content-Type: $CT" -X POST \
  --data "regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false" \
  "https://$IP/rw/rapid/execution/start"

# Stop RAPID — requires Remote Stop UAS grant
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "stopmode=stop&usetsp=normal" \
  "https://$IP/rw/rapid/execution/stop"

# Enable / disable hand-guiding (lead-through) — the palette's gofa-leadthrough node
# node also sends a socket STOP first to clear queued moves; do that yourself too if
# you're driving this manually and anything might still be moving.
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "status=active"   "https://$IP/rw/motionsystem/mechunits/ROB_1/lead-through"
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "status=inactive" "https://$IP/rw/motionsystem/mechunits/ROB_1/lead-through"

# Upload a .mod file (only replaces the file on disk — see loadmod below to make a
# running task pick it up)
curl -sk $AUTH -X PUT -H "Content-Type: text/plain;v=2.0" \
  --data-binary @rapid/MainModule.mod \
  "https://$IP/fileservice/\$HOME/Programs/MainModule.mod"

# Write the on-robot saved-points file — full overwrite, same JSON shape as points.json.
# Content-Type MUST be text/plain;v=2.0 or application/octet-stream;v=2.0 — confirmed
# live that application/json is rejected (415), even though the content is JSON.
curl -sk $AUTH -X PUT -H "Content-Type: text/plain;v=2.0" \
  --data '[{"id":"p1","name":"pick1","target":{"x":323.2,"y":-81.8,"z":807.0,"q1":0.267,"q2":0.129,"q3":0.954,"q4":-0.053,"cf1":-1,"cf4":-1,"cf6":0,"cfx":0}}]' \
  "https://$IP/fileservice/\$HOME/Programs/gofa_points.json"
```

### Write, requires edit mastership (`resetpp`, `loadmod`, `activate`)

These need a **request → action → release** sequence on **one shared session** — a
fresh `-u` call per step gets its own session, so a `release` from a different
session is a silent no-op and leaves the lock orphaned until RWS's own ~5-minute
inactivity timeout clears it (hit this live once; see `feedback-curl-mastership-needs-shared-cookie-jar`
in project memory). **Prefer the repo's own tool over hand-rolled curl for this:**

```bash
cd node-red-contrib-abb-gofa
MSYS_NO_PATHCONV=1 node mastership-test.js /rw/rapid/execution/resetpp
MSYS_NO_PATHCONV=1 node mastership-test.js /rw/rapid/tasks/T_ROB1/loadmod \
  'modulepath=$HOME/Programs/MainModule.mod&replace=true' --hal
MSYS_NO_PATHCONV=1 node mastership-test.js /rw/rapid/tasks/T_ROB1/activate \
  'module=MainModule' --hal
```

The raw curl equivalent, if you need it (shared cookie jar is mandatory):

```bash
IP=<ROBOT_IP>
CJ=/tmp/gofa_cookies.txt
AUTH="-u <username>:<password>"
CT='application/x-www-form-urlencoded;v=2.0'

curl -sk -c "$CJ" -b "$CJ" $AUTH -H "Content-Type: $CT" -X POST "https://$IP/rw/mastership/edit/request"

# resetpp — move program pointer back to Main
curl -sk -c "$CJ" -b "$CJ" $AUTH -H "Content-Type: $CT" -X POST "https://$IP/rw/rapid/execution/resetpp"

# loadmod and activate need application/hal+json — the one exception to xhtml+xml
# curl -sk -c "$CJ" -b "$CJ" $AUTH -H "Accept: application/hal+json;v=2.0" -H "Content-Type: $CT" \
#   --data "modulepath=\$HOME/Programs/MainModule.mod&replace=true" \
#   -X POST "https://$IP/rw/rapid/tasks/T_ROB1/loadmod"

curl -sk -c "$CJ" -b "$CJ" $AUTH -H "Content-Type: $CT" -X POST "https://$IP/rw/mastership/edit/release"
```

> **`loadmod` and `activate` require RAPID to be stopped.** Confirmed live in both
> directions: succeed (`204`/`200`) with RAPID stopped, `403` ("Operation not
> allowed for current PGM state") with RAPID running. `resetpp` has no such
> restriction observed. Full writeup: `abb-rws` skill and `CLAUDE.md`.

### Real-time push (WebSocket subscriptions)

Not a single curl one-liner — `POST /subscription` returns a `wss://` location you
then need an actual WebSocket client for (that's what `gofa-subscribe-io`/
`gofa-subscribe-state` do internally via the `ws` npm package). If you need this
outside Node-RED, the quickest path is a tiny Node script using this repo's own
`createRobotClient()` (`node-red-contrib-abb-gofa/nodes/gofa-robot.js`) — its
`requestRaw()`/`getCookie()` already handle the session/cookie/header details. For a
one-off status check, polling (the read-only commands above) is simpler.

---

## Part B — TCP Socket commands (port 1025)

**RAPID must be running** (`rw/rapid/execution` = `running`) — the socket server only
exists while `MainModule.mod`'s `main()` loop is executing. Every command below is
one line, newline-terminated, and gets back one line: `OK:<CMD>` or `ERR:<CMD>`.

```bash
# Linux / macOS / Git Bash (nc)
printf '<COMMAND>\n' | nc -w 3 <ROBOT_IP> 1025
```

```powershell
# Windows PowerShell — reusable one-liner
function Send-GofaCmd($cmd) {
    $tcp = New-Object System.Net.Sockets.TcpClient("<ROBOT_IP>", 1025)
    $s = $tcp.GetStream()
    $b = [System.Text.Encoding]::ASCII.GetBytes("$cmd`n")
    $s.Write($b, 0, $b.Length)
    Start-Sleep -m 300
    $r = New-Object byte[] 256
    $n = $s.Read($r, 0, 256)
    [System.Text.Encoding]::ASCII.GetString($r, 0, $n)
    $tcp.Close()
}
Send-GofaCmd "PING"
```

| Command | What it does |
|---------|-------------|
| `PING` | Connectivity test |
| `HOME` | Move to home position |
| `SETHOME` | Capture current pose as home, persist to `HOME:/Programs/gofa_home.cfg` |
| `GOTOJx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveJ (joint-interpolated) |
| `GOTOLx;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx` | Move to absolute pose via MoveL (straight-line TCP path) |
| `X+20` / `Y-10` / `Z+5` | Translate TCP ±mm in base frame (max 50 mm) |
| `RX+5` / `RY-10` / `RZ+15` | Rotate TCP ±° in tool frame (max 30°) |
| `J1+10` / `J3-5` | Jog single joint ±° (max 30°, joints 1–6) |
| `SPEED50` | Set speed override 1–100% via RAPID's `VelSet` (not `SpeedRefresh` — see CLAUDE.md's `SPEED`/`SpeedRefresh` note) |
| `GETSPEED` | Read the current override back (`C_MOTSET.vel.oride`) — replies `VAL:<value>` |
| `MOVEJ<j1;..;j6>` / `MOVEL<j1;..;j6>` | Absolute joint move in degrees — MOVEJ joint-interpolated (MoveAbsJ), MOVEL straight-line TCP path to the same joint pose (added 2.1.0) |
| `ZONE<name>` | Set path blend zone (`FINE`/`Z1`/`Z5`/`Z10`/`Z20`/`Z50`/`Z100`) |
| `STOP` | Halt motion — immediate for a jog in progress; for HOME/GOTOJ/GOTOL/MOVEJ/MOVEL it only takes effect once the current move finishes (those stopped using `\Conc` in 2.4.2) |
| `GRIPON` / `GRIPOFF` | Stub only — acks `OK:` but performs no actual I/O; kept for manual/raw-socket testing. `gofa-grip` itself uses RWS `/set-value` instead. |
| `GETVAR:<name>` | Read a `PERS` variable — replies `VAL:<value>` or `ERR:UNKNOWN_VAR` |
| `SETVAR:<name>:<value>` | Write a `PERS` variable — replies `OK:SETVAR`, `ERR:UNKNOWN_VAR`, or `ERR:PARSE` |
| `SETDO:<name>:<value>` | Set a digital output by RWS signal name (0/1) against an explicit allow-list (`ABB_Scalable_IO_0_DO1`–`DO16`) — replies `OK:SETDO`, `ERR:UNKNOWN_SIGNAL`, or `ERR:PARSE` |
| `SETLED:<r>;<g>;<b>;<period>` | Set ASI status light color (0–255 each) + hardware blink period |
| `RESETLED` | Restore ASI LED to default (solid green) |
| `P1` / `P2` / `P3` | **Removed in 2.0.0** — were legacy hardcoded pick/place positions from before the palette existed; no Node-RED node ever sent them. Use the points-based nodes (`gofa-save-point`/`gofa-go-point`) instead. |

Only `nTestVar` (num) and `sTestMsg` (string) are allow-listed for `GETVAR`/`SETVAR`
out of the box — see "Adding RAPID variables" in `README.md` to add more (that edit
is itself a Part A workflow: `gofa-file` (action: upload) → `loadmod`, RAPID stopped, then
`start` again).

Bare `GOTO<11 nums>` (no `J`/`L`) is also accepted as a `GOTOJ` alias for backward
compatibility.

This table covers `rapid/MainModule.mod` (the default). The optional
`rapid/MainModuleEGM.mod` adds one more command, `EGMJOINT`, which switches the
controller into a blocking EGM streaming session instead of serving the commands
above — see the EGM section in `README.md` for that protocol and setup.

---

## Part C — TCP Socket commands (port 1026, `T_LED`/`BackgroundLed.mod`)

A separate, optional RAPID task (see `README.md`'s ["Background task" section](README.md#background-task-backgroundledmod--t_led)
for the one-time RobotStudio setup) that keeps answering these same-shaped commands even while
`T_ROB1`/`MainModule.mod` above is stopped. **JSON only — no legacy plain-text tokens
here**, unlike Part B's `MainModule.mod` (`BackgroundLed.mod` dispatches every incoming
line straight to its JSON parser, with no text-protocol fallback). Each line must be
newline-terminated JSON, e.g. with `nc`/`ncat`:

```bash
printf '{"cmd":"ping"}\n' | nc <ROBOT_IP> 1026
# -> {"status":"ok","cmd":"ping","version":"2.4.5"}
# "version" is MODULE_VERSION from the .mod file — the palette compares it to its own
# npm version to detect a stale module; only present on the JSON wire form, not the
# plain-text "PING" -> "OK:PING" reply Part B's table above shows.

printf '{"cmd":"setled","val":[0,255,255,0]}\n' | nc <ROBOT_IP> 1026
# -> {"status":"ok","cmd":"setled"}   (cyan, no blink)

printf '{"cmd":"resetled"}\n' | nc <ROBOT_IP> 1026
# -> {"status":"ok","cmd":"resetled"}

printf '{"cmd":"setdo","name":"ABB_SCALABLE_IO_0_DO1","val":1}\n' | nc <ROBOT_IP> 1026
# -> {"status":"ok","cmd":"setdo"}
```

| Command | What it does |
|---------|-------------|
| `{"cmd":"ping"}` | Connectivity test |
| `{"cmd":"setled","val":[r,g,b,period]}` | Set ASI status light color (0–255 each) + hardware blink period |
| `{"cmd":"resetled"}` | Restore ASI LED to default (solid green) |
| `{"cmd":"setdo","name":"...","val":0\|1}` | Set a digital output by RWS signal name against the same explicit allow-list as Part B's `SETDO` (`ABB_SCALABLE_IO_0_DO1`–`DO16`, matched **case-sensitively all-caps** — no `CleanCmd`-style uppercasing on this JSON-only task) |

Any other `cmd` (including `getvar`/`setvar`/motion commands — this task has no motion
capability at all) gets `{"status":"err","cmd":"...","msg":"unsupported command"}`.

---

## Quick answers to two things that come up

**"Can I create a brand-new `PERS` variable at runtime?"** No — RAPID is compiled;
`GETVAR`/`SETVAR` only reach variables already declared in `MainModule.mod`'s source
and allow-listed in `TryGetVar`/`TrySetVar`. There's no generic RWS variable-write
endpoint either (confirmed dead on this controller — see `abb-rws` skill). Adding one
means editing the module source, uploading it, and reloading it into the task.

**"Can I do that reload while RAPID is running?"** No — `loadmod`/`activate` (Part A)
both require RAPID stopped, so the full "add a variable" flow is: stop RAPID → edit +
upload `MainModule.mod` → `loadmod` → `start` again.
