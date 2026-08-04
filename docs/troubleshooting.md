# Troubleshooting

Symptoms are grouped by what you actually see — an error string, a timeout, a node that does
nothing. Every entry describes behavior of the **current** release; fixes for problems that no
longer exist live in [CHANGELOG.md](../CHANGELOG.md).

Before anything else, two checks that explain most sudden failures:

1. **Has the robot's IP changed?** It drifts, sometimes across subnets. Run `check-status.js`
   (or `check-status.js --discover`) and compare against the `gofa-robot` config node.
2. **Is RAPID actually running?** Socket nodes need `MainModule.mod` loaded and executing in
   `T_ROB1`. `gofa-connection-status` reports RWS and the socket independently, so it tells you
   which of the two layers is down.

---

## No controller restart/backup nodes

`gofa-restart` and `gofa-backup` nodes were both built and dropped after live testing. ABB documents `POST /ctrl` (body `restart-mode=...`) and `POST /ctrl/backup?action=backup` for these — both reproduced verbatim from ABB's own current docs, and both return a hard `405 Method Not Allowed` on this controller (RobotWare 7.21.0+229), despite `OPTIONS` on each resource listing `Allow: GET,POST,OPTIONS` / `Allow: GET,OPTIONS` respectively. See the `gofa-backup`/`gofa-restart` removed note in `CLAUDE.md` for the full live-test writeup. No working alternative found; a manual restart/backup via the FlexPendant or RobotStudio still works fine.

## Socket commands time out (jog, HOME, ping …)

1. Confirm RAPID is running on the FlexPendant (green play indicator)
2. Check `rapid/MainModule.mod` — `SERVER_IP` must match your robot's actual IP. If you upload via the `gofa-file` node (or `gofa-setup`), this is kept in sync automatically from the `gofa-robot` config node's IP — no manual edit needed.
3. Re-upload the `.mod` and reload on the FlexPendant if you changed the IP
4. Verify port 1025 is reachable: `nc -zv <ROBOT_IP> 1025`

## RAPID Var Read/Write returns `ERR:UNKNOWN_VAR`

The variable is not in the `TryGetVar` / `TrySetVar` handlers in `MainModule.mod`. Add an `ELSEIF` block for it (see [Adding RAPID variables](reference.md#adding-rapid-variables)), re-upload, and reload on the FlexPendant.

## RWS returns 401

Session expired. The palette auto-retries with credentials — if it keeps failing, check the username and password in the config node.

## `gofa-rapid-exec` returns 403

| Error code | Cause | Fix |
|------------|-------|-----|
| `icode:-757` | User lacks Remote Start/Stop grant | RobotStudio → Edit User Accounts → add Remote Start/Stop grants |
| `org_code:-4501` on resetpp | Edit mastership not acquired | Update to latest palette — `resetpp` now wraps in `withMastership('edit')` automatically |
| "Operation not allowed for current PGM state" on `loadmod`/`activate` | RAPID is running | Stop RAPID first (`stop` action), then `loadmod`/`activate`, then `start` again |

## `gofa-rapid-exec` `start` fails with "motors are motoroff"

RAPID error **20055** ("program must start in Motor On state") — RWS accepts the `start`
request with HTTP 200 even when motors are off, so it can't be caught as an HTTP error.
This node checks motor state before sending `start` and reports the real reason instead of
a false `{ ok: true }`. Turn motors on with **gofa-motor** (or the FlexPendant) first. If a
`start` still fails after motors are confirmed on, the payload's `execstate`/`ctrlstate`
fields and **gofa-elog** will show the controller's actual reason.

## `gofa-subscribe-*` shows "unknown node type"

The palette isn't fully loaded. Check Node-RED's own startup log for the reason — it names the
node file and the error. This used to be caused by an unresolved `ws` dependency on a symlinked
local install; the palette has had no runtime dependencies since the WebSocket client was
hand-rolled into `nodes/lib/ws.js`, so that specific cause no longer applies.

## `gofa-subscribe-io` seems to poll instead of pushing

`gofa-subscribe-io` uses a real WebSocket subscription and only falls back to 500 ms polling if the
subscription request itself is rejected. If you see it polling, the subscribe call failed — check
the Node-RED log for the rejection, and confirm the signal name exists via `gofa-io-list`.

## `gofa-rapid-exec` `loadmod`/`resetpp`/`start` fails with "Global routine name main ambiguous"

Both `MainModule` and `MainModuleEGM` are loaded on the task at once — `loadmod`'s `replace`
option only replaces a module with the **same name**, so loading one while the other is still
loaded leaves both, and both declare `PROC main()`. Fix: `gofa-rapid-exec` → `unloadmod` for
whichever module you don't want, **before** `loadmod`-ing the other. See
[EGM → Loading MainModuleEGM.mod](reference.md#loading-mainmoduleegmmod) for the full sequence.

## `gofa-egm` `start` succeeds but no motion / "No EGM frames received within 2s"

`OK:EGMJOINT` came back and the UDP socket bound fine, but zero frames arrive from the
controller. Almost always a stale `EGM_PC` UDP Unicast Device config — its **Remote
Address** must be the Node-RED host's *current* IP, which drifts the same way the robot's own
IP does. Check it in RobotStudio (**Controller** → **Configuration** → **Communication** →
**UDP Unicast Device** → `EGM_PC`) and restart the controller after fixing it. Also
double-check the firewall rule for inbound UDP on the configured port.

## `gofa-egm` `start` fails with "bind EADDRINUSE"

Something else already holds the UDP port (default `6510`). Find and stop it:

```bash
netstat -ano | findstr 6510     # Windows
lsof -i :6510                   # Linux / macOS
```

Most often it's a previous Node-RED process that didn't exit cleanly. If you are on a release older
than 2.4, this was also a palette bug (the UDP socket leaked between `gofa-egm` node instances) —
update.

## `gofa-egm` session won't end / robot stuck unresponsive to TCP nodes after using EGM

Always use the `"stop"` action (or let the node's own redeploy/close handler run) — don't just
stop sending it messages and assume the controller will recover on its own. `gofa-egm`'s
`"stop"` sets a dedicated signal (`ABB_Scalable_IO_0_DO16`) via RWS, which triggers a RAPID
TRAP that ends the EGM session gracefully (`EGMStop`) and returns straight to TCP serving —
the RAPID task itself never stops. If the robot is stuck anyway (e.g. an interrupted Node-RED
process that never got to run its close handler, or a genuinely external stop — FlexPendant,
e-stop — while a session was active), recover manually: `gofa-rapid-exec` → `stop`, then
`resetpp`, then `start` (motors must be on).

## RAPID error "You have to disconnect an EGM instance using EGMReset before you can connect another"

This happens if RAPID is resumed with a plain **continue** start — resuming execution from
wherever the program pointer happened to be — after an EGM session was interrupted by
something *other* than `gofa-egm` itself (FlexPendant Stop, e-stop, module switching). Normal
`gofa-egm` `start`/`stop` cycles no longer stop the task at all, so this shouldn't come up in
everyday use anymore — but if RAPID ever *is* externally stopped mid-session and then resumed
with a bare "continue," the program pointer can be left sitting near/inside the EGM code block;
resuming there re-enters EGM setup without going through `RunEgmJoint`'s own `EGMReset`, which
only runs when execution starts fresh from `main()`.

**Fix**: `gofa-rapid-exec` → `stop`, then `resetpp` (resets the program pointer to the top of
`main()`), then `start`. Rule of thumb: after any *external* interruption while `gofa-egm` was
active, always `resetpp` before the next `start` — a plain "continue" start is only safe when
EGM was never involved.

**If the exact same error still happens after a genuinely fresh `resetpp` + `start`** (check
the controller's event log — it should say "Program started... from the first instruction,"
not "restarted... from where it was previously stopped"), the problem has moved to a stuck EGM
resource at the **controller level** rather than RAPID's program pointer — a full controller
restart is the only fix (EGM/UC state isn't exposed anywhere in RWS, so there's no
lighter-weight recovery). This should be rare now that normal `gofa-egm` usage doesn't
externally kill sessions anymore (see the next entry).

## RAPID error "Too many EGM instances"

RobotWare allows a maximum of **4** concurrent EGM identities. Each session that ends without
running `EGMReset` leaks one, so the pool can be exhausted in a handful of cycles.

**Recovery: restart the controller.** A leaked instance pool can't be reclaimed any other way —
`resetpp`+`start` brings RAPID back for plain TCP use but does not release the instances.

**Prevention:** always end sessions with `gofa-egm`'s `stop` action, and make sure the controller
is running the current `rapid/MainModuleEGM.mod`. An old copy without `TrapEgmStop`/`ISignalDO`
leaks one instance on every single start/stop cycle — check for those two symbols in the module
and re-run the [load sequence](reference.md#loading-mainmoduleegmmod) if they're missing.

## RWS returns 405 (method not allowed)

This palette targets **OmniCore / RWS 2.0** which uses path-based actions (e.g. `/rw/rapid/execution/start`). If you see 405, you may be connecting to an IRC5 controller running RWS 1.0 — the endpoint format is different.

**Specifically for I/O writes**: OmniCore's real action is `POST /rw/iosystem/signals/{name}/set-value` — the IRC5/general-RWS-docs path `/set` 405s unconditionally on OmniCore, on every signal, regardless of Access Level. If you ever hand-roll a curl call against `/rw/iosystem/signals/.../set` and get 405, that's this — use `set-value` instead. `gofa-do-write`/`gofa-grip` both learned this the hard way; see the note under [Files and I/O](reference.md#files-and-io) above.

---

