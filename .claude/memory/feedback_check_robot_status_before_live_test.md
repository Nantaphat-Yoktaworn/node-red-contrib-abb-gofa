---
name: feedback-check-robot-status-before-live-test
description: "Always run the /robot-status skill (check-status.js) before a live test, unless the user already gave the status; log it to the test log"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 58ab807b-429c-4693-a7f1-105ef986edca
---

Before running any live test against the robot (curl or otherwise), check current status first via the **`/robot-status` skill** (invoke it with the Skill tool, not hand-rolled curl) — it runs `node-red-contrib-abb-gofa/check-status.js` and reports Motors/Mode/RAPID/Speed/socket reachability in one call, add `--full` for RobotWare version/controller identity/task state/recent elog entries. If the user already states the current status in their message, skip the check and use what they gave — don't re-query redundantly.

**Why:** the user originally asked for this workflow (2026-07-06) after a session of live RWS testing, to make sure tests aren't run blind against an unknown robot state (e.g. testing a module load while RAPID is running, or motion-related calls while motors are off). The manual version of this (separate `curl` calls for ctrl-state/opmode/execution) was later formalized into `check-status.js` + the `/robot-status` command (commit `4f67801`, 2026-07-06) specifically so this check doesn't need hand-rolled curl every session — the user then explicitly said to always use that tool for status, not the old manual curl sequence.

**How to apply:** treat `/robot-status` as the mandatory first step before any live RWS/socket test in this project — not just when the user explicitly asks for status. It already handles the IP-drift problem (env var overrides `GOFA_IP` etc.) and reports both RWS state and socket reachability, so there's no need to separately curl ctrl-state/opmode/execution or ping the socket port by hand. Log the status snapshot alongside the test result in the running test log — see [[project-robot-live-test-log]]. Don't skip this even for "safe" read-only tests; the point is to always know the state you tested against, not just to gate risky ones.
