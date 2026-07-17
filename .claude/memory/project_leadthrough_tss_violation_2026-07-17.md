---
name: project-leadthrough-tss-violation-2026-07-17
description: "Lead-through instantly tripped 90515 Tool Speed violation with zero touch/no tool offset; fixed by a manual-mode jog, not a config or code change — plus a real HTTP-200-lies bug found and fixed in gofa-leadthrough.js along the way"
metadata:
  node_type: memory
  type: project
  originSessionId: unknown
---

`gofa-leadthrough`'s `enable` action tripped `90515 Safety Controller Tool Speed violation`
(`Transient_Contact_TSS`) every time, even with zero human touch, motors confirmed on, and
default tool data (`0kg`, `x0 y0 z0` — no TCP offset to blame). Ruled out via live testing, in
order: the Node-RED code itself (enable only sends `STOP` + `status=active`, no motion), moving
too fast, motors-off brake release, and a wrong tool frame. This project's own live-test log
(`project_robot_live_test_log` / repo `.claude/memory/project_robot_live_test_log.md`) had no
record of lead-through ever working before, so it may have been broken since commissioning, not
a regression.

**Actual fix (found by the user, not diagnosed via RWS):** physically jog the robot briefly from
the FlexPendant in **Manual mode**, holding the enabling ("back") device to bring motors on and
run lead-through from there once. After that single manual-mode cycle, Auto-mode lead-through
(the RWS path this palette actually uses) started working normally.

**Why:** working theory (unconfirmed against ABB docs, not asserted as fact) is that the safety
controller's `Transient_Contact_TSS` speed observer held a stale/uninitialized reading — possibly
left over from a controller restart earlier that session — that only gets resynced by a real
manual-mode motion under the physical enabling device. Auto-mode collaborative supervision alone
never triggered that resync on its own.

**How to apply:** if this recurs (same robot or a similar OmniCore/GoFa setup) — `90515
Transient_Contact_TSS` trips instantly on lead-through enable, with RWS-side diagnostics all
clean (motors on, no touch, no tool offset) — don't jump straight to a RobotStudio Safety-config
edit. Have the user jog the robot briefly in Manual mode with the enabling device held, then
retry in Auto mode, before escalating to checking the actual `Transient_Contact_TSS` limit value.

**Real code bug found and fixed regardless of the root cause above:** `gofa-leadthrough.js`'s
`enable` action trusted the RWS POST's `2xx` as success, but confirmed live that the safety
controller can accept the POST and then immediately revert `status` back to `Inactive` — the
node was reporting a false `ok:true`. Fixed with a `waitForLeadThroughState()` poll (mirrors
`gofa-rapid-exec`'s `start` action's existing "HTTP 200 lies" guard: poll real state after the
POST, 1500ms/300ms) added to both the runtime `enable` handler and the admin-panel `/toggle`
endpoint. Two tests added/updated in `test.js`.
