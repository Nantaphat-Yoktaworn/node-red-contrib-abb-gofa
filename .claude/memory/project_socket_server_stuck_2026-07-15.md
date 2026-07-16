---
name: project-socket-server-stuck-2026-07-15
description: RESOLVED-BY-REINSTALL (root cause still unconfirmed) — RAPID socket server (port 1025) went unresponsive mid-live-test 2026-07-15 while RWS reported rapid:running; recovered same day by full module reinstall via gofa-setup
metadata: 
  node_type: memory
  type: project
  originSessionId: 13ffd05a-32a0-4689-8d62-b5ee7b0f1152
---

During the live test of the new [[project_output_payload_checkbox]] feature on 2026-07-15
(robot at 192.168.1.103, confirmed via `/robot-status` as healthy — motors on, AUTO, RAPID
running, socket 18ms RTT — immediately before the test run started), the TCP socket server
(port 1025) went unresponsive partway through the run. Every socket-based node (`gofa-ping`,
`gofa-zone-set`, `gofa-speed-set`, `gofa-stop-motion`, `gofa-rapid-var-read/write`,
`gofa-asi-led`, `gofa-do-write` [socket transport], `gofa-jog`, `gofa-joint-jog`, `gofa-movej`,
`gofa-move`, `gofa-go-point`, `gofa-sequencer`, `gofa-egm` start) began returning
`socket timeout` from that point on. RWS-based nodes kept working fine throughout (status,
pose, joints, elog, io-list, di-read, rapid-tasks, file-read, motor, grip, rapid-exec all
succeeded or failed for unrelated/expected reasons — e.g. `gofa-motor` got a real `403`,
a pre-existing UAS permission gap, not related to this bug).

A **standalone, independent** `check-status.js --full --json` run immediately after the test
suite finished confirmed the outage wasn't a harness artifact: `socket.ok: false,
"error": "socket timeout"`, while `rapid` still read `"running"` and `full.tRob1.excstate`
still read `"started"`. The elog (`domain=0`) showed, during the test window:
`10125 "Program stopped"` → (~60s gap) → `10002 "Program pointer has been reset or removed"`
→ `10052 "Regain start"`. The user confirmed no one else was using the robot during this
window — whatever triggered it traces back to this test session, not an external actor.

**Not yet root-caused.** Candidate leads, none confirmed:
- The one action in the test sequence that could plausibly perturb RAPID execution state is
  `gofa-rapid-exec` with `action:'start'` (body `regain=continue&execmode=continue&...`) called
  while RAPID was *already* running — but that call happened well *after* the first socket
  timeout (`gofa-ping`, much earlier in the sequence), so it can't be the original trigger,
  though it may explain the later `"Regain start"` entry (its own `waitForExecState` polling
  confirmed RWS-visible `execstate` did reach `running` again — yet the socket stayed dead,
  suggesting the program pointer came back "running" somewhere that isn't the top of `main()`'s
  socket-accept loop, not a full clean restart from the top).
- `gofa-egm` `start` (sends `EGMJOINT`) was tested near the end of the sequence and itself
  timed out waiting for even the `OK:EGMJOINT`/`ERR:EGMJOINT` ack — consistent with the socket
  server already being wedged by that point, not a new cause.
- No test in the sequence called `stop`, `resetpp`, `loadmod`, or `unloadmod` — those were
  deliberately skipped as the higher-risk, module-state-disrupting actions (see the live-test
  session for the full reasoning) — so the `"Program stopped"` (10125) origin is still
  unexplained by anything this test script issued directly.

**Not this feature's bug.** The [[project_output_payload_checkbox]] gating mechanism itself
(`nodes/lib/gate.js`) only wraps the `send`/`node.send` call each node already made — it has
zero interaction with socket connection handling, and every node in the run (including the
ones that timed out) still correctly gated its output (`default-state output={}` even on the
timeout error path, full error payload when checked) — the checkbox feature is fully validated
independent of this incident.

**How to apply**: before the next live socket test, run `/robot-status` first as always, and if
`socket.ok` is false while `rapid` reads `running`, don't assume a quick `resetpp`+`start` will
fix it without checking RAPID's actual current instruction/PP location first (e.g. via the
FlexPendant) — this session's `rapid-exec start` already tried the RWS-only version of that fix
and it did NOT restore socket serving, so the socket-accept loop specifically may need a full
task restart (`stop` → `resetpp` → `start`) or, if that also fails, the controller-restart
fallback already documented for the EGM "stuck UC resource" case in CLAUDE.md — this may be the
same underlying class of issue (RAPID execution state and TCP-serving state can apparently
diverge) rather than something new.

**RECOVERED later the same day (2026-07-15), root cause still unconfirmed.** After the user's
in-person intervention (robot found with RAPID *stopped*, motors off, AUTO — so someone/something
had stopped the task since the incident), the [[project-setup-and-mod-edit-nodes]] live test
performed a full wipe (unloadmod MainModuleEGM — note: the *EGM* module was the one loaded at
recovery time, not plain MainModule — plus fileservice DELETE of both .mod files) and a fresh
`gofa-setup` run (upload → loadmod → resetpp → motors on → start). Socket serving came back
immediately and answered PING both via the setup node and an independent check. So: a clean
`resetpp`+`start` from a genuinely stopped task with a freshly loaded module DOES restore socket
serving — what specifically wedged the accept loop during the incident (while execstate claimed
`running`) was never diagnosed; if it recurs, capture the PP location on the FlexPendant before
recovering.
