---
name: omnicore-ethernet-switch-section
description: "OmniCore C30's 'ETHERNET SWITCH' connector is one port among WAN/LAN/MGMT/ABB Ability/HMI, not a separate 5-port X1-X5 block — corrected against the full official manual"
metadata:
  node_type: memory
  type: reference
  originSessionId: 2c91e9b1-4291-4119-a02a-ea89dc41f357
---

**Corrected 2026-07-24 against the full official product manual text** (`3HAC089064-001` Rev F,
§3.5.8 "Ethernet networks on OmniCore" — full text at
`nnnn/note/3HAC089064-001_OmniCore_C30_Type_A_Detailed_Product_Manual.md`). The prior version of
this memory (below, kept for history) was sourced from a ManualsLib mirror's back-panel diagram
and speculated a separate 5-port "ETHERNET SWITCH" section (X1–X5, RJ45). **That is not
corroborated by the full manual.** Searching the complete manual text for "RJ45" and "X1" near
"ETHERNET SWITCH" turns up nothing matching a 5-port switch block — the only RJ45 mentions
elsewhere in the manual are for an unrelated Ethernet floor-cable spare part.

**What the manual actually documents (§3.5.8, connector diagram on its page 112):** the
controller's Ethernet-related connectors are seven single labeled ports across three network
segments:

| Port | Segment | Purpose (manual's own wording) |
|------|---------|----------------------------------|
| I/O | Private Network | Chaining additional ABB Scalable I/O units |
| **ETHERNET SWITCH** | Private Network | Connecting ABB Scalable I/O units + local network-based process equipment |
| ABB Ability™ | Ability Network | Internet / ABB Ability™ cloud connection |
| **WAN** | Public Network | Connecting the controller to a factory-wide industrial network |
| **LAN** (LAN3 on C90XT/V-line) | I/O Network | Connecting to a factory-wide industrial network **isolated from WAN** |
| MGMT | Private Network | ABB service personnel, single client only |
| HMI | — | FlexPendant |

So **"ETHERNET SWITCH" is a single RJ45 port**, not a 5-port switch block — see the
`omnicore-c30` skill's Connectors section for the full corrected table (also covers what LAN vs.
WAN are actually for — see [[project_wan_port_actual_wiring]]).

**Why:** an earlier session extrapolated from a lower-quality mirrored PDF and a tangential
DSQC1035 Ethernet-switch-module search result; the full manual text (obtained later) doesn't
support that reading. Same pattern as several other entries in this project's memory/CLAUDE.md —
verify against the primary manual text before trusting a mirror/snippet-derived guess.

**How to apply:** if asked what the "ETHERNET SWITCH" port is for, answer per the table above
(Private Network, Scalable I/O + local process equipment) — don't describe it as a 5-port
X1–X5 block anymore. This still has no RWS/RAPID API surface — pure physical network wiring,
not something to build a Node-RED node around.

---

**Original entry (2026-07-?), superseded above, kept for history — do not treat as current:**

Confirmed via ABB's OmniCore C30 Product Manual back-panel/spare-parts diagram (page 585 of the
ManualsLib mirror of the Product Manual): the controller's back panel has a section explicitly
labeled "ETHERNET SWITCH" with 5 RJ45 ports (X1–X5), physically separate from WAN/LAN/MGMT.
Functional conclusion at the time (reasoned, not manual-sourced): since it's a plain switch, all
5 ports were assumed electrically equivalent. **This 5-port claim could not be corroborated
against the full official manual text and should be treated as unconfirmed/likely wrong** — see
the corrected section above.
