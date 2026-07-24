---
name: project_wan_port_actual_wiring
description: This project's Node-RED host has always been physically wired to the controller's WAN port, not LAN, for RWS + socket control
metadata:
  type: project
---

The C30 controller's Ethernet switch panel has three network-role ports relevant here: WAN,
LAN, MGMT (plus ETHERNET SWITCH/ABB Ability™/HMI — see
[[reference_omnicore_ethernet_switch_section]]). Per the full official product manual
(`3HAC089064-001` Rev F, §3.5.8, confirmed 2026-07-24 by reading the actual manual text at
`nnnn/note/3HAC089064-001_OmniCore_C30_Type_A_Detailed_Product_Manual.md`): **WAN is the
"Public Network" port**, described as "intended for connecting the robot controller to a
factory wide industrial network" — a general-purpose factory-network port, not an
internet-only/RobotStudio-only link. **LAN is the "I/O Network"**, a *second*, isolated
factory-network segment ("isolated from WAN"), not "the local/service/RWS port" as an earlier
version of the `omnicore-c30` skill implied (that implication was drawn from the shorter
product-spec doc and a `RobotStudio Connect [3119-1]`-focused reading, not this fuller manual
section).

**On this project's actual lab setup, the Node-RED host has always connected via the
controller's WAN port for the whole project's history** — not LAN — confirmed directly by the
user (2026-07-24). This is fully consistent with the manual once read correctly: WAN is the
general factory-network port, exactly the role RWS + the RAPID socket connection plays here.

**Why:** the skill doc originally stated "RWS is accessed via the LAN port" as flat fact, sourced
from the shorter product-spec doc, without a "confirmed live" tag — this is the same pattern as
several other entries in `CLAUDE.md` ("ABB's own docs failing/misleading vs. this lab's live
reality"), just for physical wiring/network-role docs instead of an RWS endpoint this time.

**How to apply:** don't advise moving the connection to the LAN port, and don't assume "LAN =
local/RWS port" — that was never actually correct per the full manual, let alone this lab's
wiring. `.claude/commands/omnicore-c30.md`'s Connectors section has the corrected WAN/LAN/MGMT
table sourced from the full manual.
