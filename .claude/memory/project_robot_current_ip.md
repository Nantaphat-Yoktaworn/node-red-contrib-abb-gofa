---
name: project-robot-current-ip
description: "Robot's current IP address, tracked because it drifts frequently — check this before trusting any hardcoded/documented default"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2fe0fd58-9b96-4052-b0d4-0f8dffaf0354
---

As of 2026-07-16, the robot is still at `192.168.1.103` (re-confirmed live via `check-status.js
--json --full`: RWS reachable, motors on, AUTO, RAPID running, RobotWare 7.21.0+229, socket
19-36ms RTT across two checks). Unchanged since 2026-07-15. Before that: `192.168.20.14` as of
2026-07-09, and originally `192.168.20.33`/`.36`.

**Why:** the robot's IP drifts often (has changed multiple times across sessions, including a
full subnet change `192.168.20.x` → `192.168.1.x`), likely DHCP on the lab network.

**How to apply:** never trust a hardcoded default IP anywhere in this repo without verifying
first — always run `/robot-status` (which will report `RWS: ... timeout` clearly if a default
is stale) and pass `GOFA_IP=<current-ip>` once you know the real address.

**Update on the "don't touch the doc defaults" policy below**: as of the [[project_docs_audit_2026-07-16]]
full-repo doc audit, the user explicitly asked to sync *all* documentation to actual project
state — that request covers the hardcoded IP defaults too, so `CLAUDE.md`'s connection table,
`check-status.js`/`mastership-test.js`'s `GOFA_IP` fallback, `MANUAL_CONTROL.md`, and the
abb-rws/omnicore-c30 skills were all updated to `192.168.1.103` in that pass (commit `d589a13`).
**The original policy still holds for casual mentions of drift going forward**: don't
proactively re-sync every doc's IP just because a `/robot-status` check shows a new value in a
routine session — that would churn the repo for a value that won't stay accurate anyway. Only
do a repo-wide IP sync again when the user explicitly asks for one (as they did this time),
otherwise just update this memory and move on.
