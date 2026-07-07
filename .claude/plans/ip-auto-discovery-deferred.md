# IP auto-discovery for check-status.js — deferred, not building now

## Context

Follow-up to the already-shipped `check-status.js` preflight tool (previous
plan in this same file, now implemented and merged — see
`node-red-contrib-abb-gofa/check-status.js`, `nodes/gofa-robot.js`'s
`createRobotClient()`, `.claude/commands/robot-status.md`). The robot's IP has
drifted before (CLAUDE.md's documented default `192.168.20.33` vs.
`192.168.20.36` seen in live tests), so the user asked whether the tool could
auto-find the robot's current IP if it changes again.

A design was sketched (two-phase local-subnet scan: cheap TCP-connect probe
across the machine's own `/24` on ports 443/1025 to narrow candidates, then
confirm with a real RWS login / socket `PING` using the existing credentials;
cache the last confirmed-good IP outside git; `--discover`/`--no-discover`
flags). When asked to confirm that approach, **the user chose to save the
idea for later rather than approve building it now.**

## Outcome of this planning session

**No code changes.** Nothing in `check-status.js`, `gofa-robot.js`, or
anywhere else is being modified as part of this request. The full design has
been recorded in memory
(`project_ip_discovery_deferred.md`) so a future session doesn't need to
re-derive or re-propose it from scratch — but it should confirm with the user
that they actually want it built at that point, since it was deferred, not
approved.

If the user decides to proceed later, the starting point is the design above:
`node-red-contrib-abb-gofa/lib/discover-robot.js` (new, pure-ish/testable
subnet-range + candidate-confirmation logic) wired into `check-status.js`'s
existing IP-resolution path (currently just `GOFA_IP` env var → hardcoded
default in `check-status.js`), plus doc updates to `CLAUDE.md` and
`.claude/commands/robot-status.md`.

## Verification

N/A — no changes made.
