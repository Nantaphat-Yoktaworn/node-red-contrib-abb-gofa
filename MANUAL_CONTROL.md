# Manual Robot Control (No Node-RED)

Every command below is what the palette's own nodes actually send — copied from the
source in `node-red-contrib-abb-gofa/nodes/`, not re-derived — so you can control or
inspect the robot directly with `curl` / a raw TCP client, for debugging, scripting,
or when Node-RED itself isn't available.

Replace `<ROBOT_IP>` with the controller's current IP (`192.168.20.36` at time of
writing — see the `SERVER_IP` note in `CLAUDE.md`, it has drifted before) and
`<username>`/`<password>` with your RWS credentials (`NNNN` / `robotics` by default).

## The one thing that decides which half of this doc you need

| | Availability |
|---|---|
| **Part A — RWS (HTTPS, port 443)** | Works whenever the controller is powered on and reachable — RAPID does **not** need to be running. Two specific actions (`loadmod`, `activate`) are the exception: see the callout below. |
| **Part B — TCP Socket (port 1025)** | Only works while **RAPID is actually executing** `MainModule.mod`'s `main()` loop — that loop is what opens the socket server. If RAPID is stopped, every socket command (even `PING`) times out. This is expected, not a bug (`check-status.js` reports it as `Socket: ERROR (socket timeout)` whenever `RAPID: stopped`). |

So: status/telemetry/motor-on/upload-a-file/start-RAPID all work over RWS with RAPID
stopped. Anything that **moves the robot, reads/writes a `PERS` variable, or touches
the ASI LED** needs RAPID running first (Part B) — chicken-and-egg only for the very
first `start`, which is itself a Part A (RWS) command.

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

# Speed override, 0-100
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

# Check who (if anyone) currently holds edit mastership
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
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "lvalue=1" "https://$IP/rw/iosystem/signals/<SIGNAL_NAME>/set"

# Start RAPID — requires Remote Start UAS grant, AUTO mode, motors on
curl -sk $AUTH -H "Content-Type: $CT" -X POST \
  --data "regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false" \
  "https://$IP/rw/rapid/execution/start"

# Stop RAPID — requires Remote Stop UAS grant
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "stopmode=stop&usetsp=normal" \
  "https://$IP/rw/rapid/execution/stop"

# Enable / disable hand-guiding (lead-through) — the palette's gofa-leadthrough-enable
# node also sends a socket STOP first to clear queued moves; do that yourself too if
# you're driving this manually and anything might still be moving.
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "status=active"   "https://$IP/rw/motionsystem/mechunits/ROB_1/lead-through"
curl -sk $AUTH -H "Content-Type: $CT" -X POST --data "status=inactive" "https://$IP/rw/motionsystem/mechunits/ROB_1/lead-through"

# Upload a .mod file (only replaces the file on disk — see loadmod below to make a
# running task pick it up)
curl -sk $AUTH -X PUT -H "Content-Type: text/plain;v=2.0" \
  --data-binary @rapid/MainModule.mod \
  "https://$IP/fileservice/\$HOME/Programs/MainModule.mod"
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
| `SPEED50` | Set speed override 1–100% |
| `MOVEJ<j1;j2;j3;j4;j5;j6>` | Absolute joint move in degrees |
| `ZONE<name>` | Set path blend zone (`FINE`/`Z1`/`Z5`/`Z10`/`Z20`/`Z50`/`Z100`) |
| `STOP` | Halt motion immediately |
| `GRIPON` / `GRIPOFF` | Gripper control via digital output |
| `GETVAR:<name>` | Read a `PERS` variable — replies `VAL:<value>` or `ERR:UNKNOWN_VAR` |
| `SETVAR:<name>:<value>` | Write a `PERS` variable — replies `OK:SETVAR`, `ERR:UNKNOWN_VAR`, or `ERR:PARSE` |
| `SETLED:<r>;<g>;<b>;<period>` | Set ASI status light color (0–255 each) + hardware blink period |
| `RESETLED` | Restore ASI LED to default (solid green) |

Only `nTestVar` (num) and `sTestMsg` (string) are allow-listed for `GETVAR`/`SETVAR`
out of the box — see "Adding RAPID variables" in `README.md` to add more (that edit
is itself a Part A workflow: `gofa-upload-mod` → `loadmod`, RAPID stopped, then
`start` again).

Bare `GOTO<11 nums>` (no `J`/`L`) is also accepted as a `GOTOJ` alias for backward
compatibility.

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
