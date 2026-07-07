---
name: omnicore-ethernet-switch-section
description: "OmniCore C30 back panel has a separate 'ETHERNET SWITCH' section (5 RJ45 ports X1-X5), distinct from the WAN/LAN/MGMT network ports"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2c91e9b1-4291-4119-a02a-ea89dc41f357
---

Confirmed via ABB's OmniCore C30 Product Manual back-panel/spare-parts diagram (page 585 of the ManualsLib mirror of the Product Manual): the controller's back panel has a section explicitly labeled **"ETHERNET SWITCH"** with 5 RJ45 ports (X1–X5), and this is a **physically separate section from the WAN/LAN/MGMT network ports** already documented in the `omnicore-c30` skill's connector table.

**Not fully confirmed from manual text**: an earlier session first (wrongly) associated a 4-port breakdown — "ABB Connect, WAN1, WAN2, LAN" — with this switch section, sourced from search snippets about the `DSQC1035` (`3HAC059187-001`) Ethernet Switch module. That breakdown almost certainly belongs to the **WAN/LAN/MGMT block** instead (those are genuinely different logical networks), not this separate 5-port switch section. Multiple direct PDF fetches (library.e.abb.com, manualslib.com page-by-page) failed to produce an exact per-port (X1–X5) function table — either blocked (403) or landed on unrelated pages.

**Functional conclusion (reasoned, not manual-sourced)**: since this is described as a plain "switch" (not a router), and a switch's defining property is that it bridges ports onto one network rather than separating them like WAN/LAN do, all 5 ports (X1–X5) are almost certainly electrically equivalent — plugging into any one of them should reach the same network. This is inferred from what "Ethernet switch" means as a device class, not confirmed ABB documentation text.

**How to apply**: if asked what these 5 ports are for, say they're extra physical LAN-side connection points (all the same network, unlike WAN/LAN/MGMT which are genuinely separate), useful for plugging in additional devices (PC, camera, second controller) without an external switch — but don't claim a specific ABB Connect/WAN1/WAN2/LAN-style per-port breakdown for this section specifically, that was already corrected once. This has no RWS/RAPID API surface at all — it's pure physical network wiring, not something to build a Node-RED node around. To empirically confirm which logical network these ports actually bridge to (rather than guess further from PDFs), the fastest path is plugging a laptop into one of X1–X5 and reading the IP/subnet it gets — faster than more manual-mirror spelunking, which hit diminishing returns this session (~8 search/fetch calls, several blocked/wrong-page).
