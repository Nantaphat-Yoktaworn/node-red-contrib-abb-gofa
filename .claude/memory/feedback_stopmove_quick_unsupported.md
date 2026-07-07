---
name: feedback_stopmove_quick_unsupported
description: "StopMove's \\Quick switch fails to compile on this controller despite being documented in ABB's general RAPID reference - never use it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b4c0b98-980a-4dc2-b1a3-6218ede82b8f
---

`StopMove \Quick;` fails RAPID's program consistency check on this controller (RobotWare
7.21.0+229 / OmniCore C30) with "reference to unknown optional parameter Quick" — even though
ABB's general RAPID Instructions/Functions/Data Types reference manual documents
`StopMove [\Quick] [\AllMotionTasks]` as valid syntax. Confirmed live via the FlexPendant's
Program Editor "Check Program" (Manual mode) error output, not a guess.

**Why**: unclear — could be a RobotWare-version difference, could be something else about this
controller's build. Not investigated further since the fix is trivial (just don't use it).

**How to apply**: always use plain `StopMove;` (optionally with `\AllMotionTasks` if ever
needed, though that hasn't been tested either) on this controller. Don't reach for `\Quick` even
though it's in ABB's official docs — this project has hit this exact "reference to unknown
optional parameter" failure more than once across sessions before finally getting it recorded
here. If revisiting RAPID motion-stop code, check this memory first.
