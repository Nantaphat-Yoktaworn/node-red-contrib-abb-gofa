---
name: reference_robot_ip_drift
description: "The GoFa controller's IP address changes frequently, sometimes multiple times per day — never trust a recorded IP, always re-check"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b4c0b98-980a-4dc2-b1a3-6218ede82b8f
---

The controller's IP is not stable. Documented default in CLAUDE.md is `192.168.20.33`; on
2026-07-07 alone it was seen at `.36` earlier in the day and `.15` later — two drifts in one
session. `check-status.js`/`mastership-test.js` both hardcode a hopeful default (`GOFA_IP` env
var override) that is frequently wrong.

**How to apply**: always run `/robot-status` (or `node check-status.js`) first to get the
current live IP before any live test, rather than trusting CLAUDE.md's table, a script's
hardcoded default, or what a previous session recorded. If the controller is reported
`UNREACHABLE` at the expected IP, ask the user for the current one rather than assuming the
robot is powered off — see [[feedback_ambiguous_hardware_test_result]].

Root cause not investigated (DHCP lease churn on the robot's network segment is the likely
suspect, unconfirmed).
