---
name: project-robot-current-ip
description: "Robot's current IP address, tracked because it drifts frequently — check this before trusting any hardcoded/documented default"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2fe0fd58-9b96-4052-b0d4-0f8dffaf0354
---

As of 2026-07-09, the robot is at `192.168.20.14` (user-confirmed, "today robot will be .14").
The documented/hardcoded default baked into `check-status.js`/`CLAUDE.md` is `192.168.20.36`,
which was already stale before this — that default itself is unreachable now (confirmed live:
RWS request timeout on `192.168.20.36`, works fine on `.14`).

**Why:** the robot's IP drifts often (has changed multiple times across sessions — `.33` was
the original documented default, then `.36`, now `.14`), likely DHCP on the lab network.

**How to apply:** never trust `CLAUDE.md`'s or `check-status.js`'s hardcoded default IP without
verifying first — always run `/robot-status` (which will report `RWS: ... timeout` clearly if
the default is stale) and pass `GOFA_IP=<current-ip>` once you know the real address. Don't
update the hardcoded default in `CLAUDE.md`/`check-status.js` itself just because it changed
again — the user explicitly asked to track this in memory instead, since editing the doc
default every time it drifts would just churn the repo for a value that won't stay accurate
anyway. Only update the tracked doc default if the user explicitly asks for that (they didn't
this time — see [[project_egm_node_red_integration_plan]] session's follow-up where this came
up but was scoped down to "just update memory").
