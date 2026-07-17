# OmniCore C30 Type A — Controller Reference

Sources: Product manual 3HAC089064-001 Rev F; Product specification 3HAC065034-001 Rev W
(OmniCore C line); Application Manual "Controller Software" 3HAC066554 and System Parameters
3HAC065041 (from the local RobotStudio doc package `ABB.RobotWareDoc.OmniCore-7.10`); live
queries against the controller itself.  
Used with: ABB GoFa CRB 15000 in this project

---

## Overview

Compact OmniCore C-line controller. Runs **RobotWare 7**. Integrates motion control, safety (SafeMove), I/O, and networking in one cabinet. For CRB 15000 the controller ships as a paired unit — the drive system label on top identifies which manipulator variant it supports.

---

## Physical

| Parameter | Base version | Desktop version |
|-----------|-------------|-----------------|
| Width | 449 mm | 509 mm |
| Depth | 443.5 mm | 513.5 mm |
| Height (with foot) | 191 mm | 193 mm |
| Weight (standard) | 25 kg | — |
| Weight (CRB 15000) | 20 kg | — |

IP20 cabinet interior. FlexPendant is IP65.

---

## Power

| Parameter | Value |
|-----------|-------|
| Voltage (CRB 15000) | 100–230 VAC, 1 phase |
| Voltage (other robots) | 220–230 VAC, 1 phase |
| Frequency | 50–60 Hz ±3% |
| Voltage tolerance | +10% / –15% |
| External fuse (CRB 15000, 100 VAC) | 10 A |
| External fuse (CRB 15000, 230 VAC) | 6 A |
| Residual current (CRB 15000) | < 3.5 mA |

No internal fuse — add external time-delay fuse or class K circuit breaker. External RCD (earth fault protection) required.

Heat loss for CRB 15000 configuration: **92 W** (recommended cooling capacity 180 W).

---

## Operating Conditions

| Parameter | Value |
|-----------|-------|
| Min ambient temp | +5°C |
| Max ambient temp | +45°C |
| Max altitude | 2,000 m |
| Humidity | ≤85% RH at 0–30°C; absolute ≤25 g/m³ above 30°C |
| Vibration | Max 2.86 m/s² (X, Y, Z) |

Storage: –40°C to +55°C (short-term to +70°C). Must reach operating conditions for 6 hours before power-on after cold storage.

---

## Drive System

The drive system label on top of the controller determines which manipulator can be connected. **Controllers with different drive systems are not interchangeable.**

| Drive system | Manipulator |
|--------------|-------------|
| **D7** | CRB 15000-5/0.95 (5 kg payload) |
| **D10** | CRB 15000-10/1.52 and CRB 15000-12/1.27 |
| B3 | IRB 1010, 1100, 1200, 1510, 1520, 1600, 1660ID |

The drive unit for CRB 15000 is located **inside the manipulator**, not in the controller cabinet.

---

## Connectors (front panel)

| Label | Name | Notes |
|-------|------|-------|
| Q0 | Power inlet switch | Main power on/off |
| X0 | Power inlet connector | AC mains |
| X1 | Motor connector | To manipulator motors |
| X2 | Customer flange interface | CRB 15000 only (SMB not used for CRB 15000) |
| X4 | HMI connector (TPU) | FlexPendant |
| X17 | DeviceNet (IP20) | Option |
| X45 | Power outlet (IP20) | Option |
| K2 | Robot signal exchange proxy | Safety signals |
| K4 | Ethernet switch | Option |
| K5.1 | Scalable I/O | Baseline on CRB 15000 variant |
| K7 | Connected Services Gateway | 3G cellular (baseline), wired Ethernet (option) |

Network ports on Ethernet switch panel: **WAN**, **LAN**, **MGMT**. RWS is accessed via the LAN port.

---

## Safety

- Safety category: **3**, performance level **d** (EN ISO 13849-1)
- Meets EN ISO 10218-1:2011
- PFH ≤ 1.3 × 10⁻⁷ /hour (basic + extended safety functions)

Basic safety functions (PL d):
- Three-position enabling device (FlexPendant)
- Emergency stop (FlexPendant + external)
- Protective stop (automatic and general stop inputs)
- Safe Disable of Drive Unit

Extended safety functions (SafeMove option):
- Axis/tool position supervision, axis/tool speed supervision, tool orientation supervision, standstill supervision

---

## Operating Modes

| Mode | Access |
|------|--------|
| Manual Reduced Speed | FlexPendant key switch |
| Manual Full Speed | FlexPendant key switch |
| Automatic | FlexPendant key switch |

RWS `/rw/panel/opmode` returns: `auto`, `manualreduced`, `manualfull`

---

## RWS Network Access (this project)

- IP drifts often (confirmed `192.168.1.103` as of 2026-07-16) — always check via `/robot-status`, never hardcode one
- Port: 443 (HTTPS, self-signed cert — use `-k` with curl)
- Auth: Basic (admin account) → cookie session (auto-refresh on 401)
- See `/abb-rws` skill for full endpoint reference

---

## RAPID Task Architecture

Confirmed live via `GET /rw/rapid/tasks` — this controller runs **3 RAPID tasks**, not just
the one you write RAPID for:

| Task | Type | Purpose (inferred) |
|------|------|---------------------|
| `T_ROB1` | normal, motion task | Your program — runs `MainModule.mod` |
| `SC_CBC` | semistatic | Built-in, likely safety/collision-related (GoFa's "safety controller"); name uncontirmed beyond the abbreviation |
| `T_GOFA_LED` | semistatic | Built-in — controls the ASI status light hardware. `T_ROB1`'s own `TrySetLed`/`SETLED` handler works via `SetGO` on signals (`Asi1LedRed` etc.) provided by the `GOFA_ASI_Procedures` SysMod loaded into `T_ROB1` — separate from this task |

**Checked for a conflict with `gofa-asi-led`, none found (~23s window):** set the LED to a
distinctive solid color via socket `SETLED`, confirmed via RWS (`Asi1LedRed/Green/Blue`
signals) that it held steady at +0s/+8s/+23s, and the user visually confirmed no change on the
physical light either. No evidence `T_GOFA_LED` overwrites colors set via this project's
`SETLED`/`RESETLED` — but this was a short window with the robot otherwise idle; a longer
observation or a state-change trigger (e.g. a RAPID error, motor on/off) could still reveal
one if `T_GOFA_LED` reacts to specific events rather than polling continuously.

`T_ROB1`'s loaded modules (`GET /rw/rapid/tasks/T_ROB1/modules`): `MainModule` (`ProgMod` —
this project's code), plus `GOFA_ASI_Procedures`, `BASE`, `Wizard_Params` (`SysMod` — ABB/
system-provided, not part of this repo).

**ASI arm buttons (`Asi1Button1`/`Asi1Button2`) are visible over RWS even under Wizard.** The
FlexPendant's ASI menu lets you assign each physical button to a Wizard function (e.g. "Add a
move position" — inserts a move block into a Wizard-authored program). Tested live whether that
assignment hides the press from RWS: polled `GET /rw/iosystem/signals/Asi1Button{1,2}` (plain
`DI`, `lvalue`) while the user tapped button 2 with "Add a move position" still assigned in the
FlexPendant UI — caught a real `0→1→0` edge over RWS, then confirmed again via a genuine
WebSocket subscription (see the IO-subscription suffix finding in the `abb-rws` skill) which
pushed the same edge with no polling delay. So `Wizard_Params`/`GOFA_ASI_Procedures` read the
signal rather than intercepting it — the button is a normal DI regardless of what the
FlexPendant menu says it's "for," readable with `gofa-di-read` and subscribable with
`gofa-subscribe-io` today, no new node required.

**Multitasking option [3114-1]**, per ABB's OmniCore C-line product manual (3HAC065034-001):
enables running up to 20 concurrent RAPID tasks (beyond the base motion task), used for things
like supervising signals or driving peripheral equipment in parallel with robot motion. This
controller clearly runs 3 tasks — **resolved 2026-07-07**: `GET /rw/system` confirms
`3114-1 Multitasking` is genuinely installed on this controller (full options list also in the
`abb-rws` skill's version-snapshot section), so it's installed, not just an assumption.

**The 3 tasks identified live (2026-07-17)**, via `GET /rw/rapid/tasks` and
`GET /rw/rapid/tasks/{name}`:

| Task | Type | Trust | Entry point | What it is |
|---|---|---|---|---|
| `T_ROB1` | normal | SysFail | `main` | The motion task — `MainModule.mod`'s socket server runs here. Stopped by `POST /rw/rapid/execution/stop`. |
| `SC_CBC` | semistatic | SysHalt | `sc_cbc_main` | No modules visible (`GET /rw/rapid/tasks/SC_CBC/modules` → empty `<ul>`). Almost certainly tied to the licensed `3043-3 SafeMove Collaborative` option ("CBC" = Collaborative Behavior Configuration) — a safety-controller-side function, hence the severe `SysHalt` trust level. |
| `T_GOFA_LED` | semistatic | None | `GOFA_LedMain` | Runs a `GOFA_Main` `SysMod`. Almost certainly ABB's own built-in driver for the collaborative-robot status light — explains why the ASI LED signals (`Asi1LedRed`/`Green`/`Blue`/`Period`) don't expose an editable `Access Level` in RobotStudio (they're already owned by protected firmware). Confirmed genuinely protected, not just hidden: `GET /rw/rapid/tasks/T_GOFA_LED/modules/GOFA_Main/text` → `500 "Module encoded, noview or readonly"`, and its own `GET /rw/cfg/sys/CAB_TASKS/instances/T_GOFA_LED` is `rdonly: true` with an empty attribute list. **Do not attempt to read, edit, or repurpose this task/module** — see the top-level `CLAUDE.md`'s "Background LED task" section for why a *separate* new task (`BackgroundLed.mod`) is used instead.

**Confirmed live: `SEMISTATIC` tasks survive `POST /rw/rapid/execution/stop`, `NORMAL` doesn't.**
Stopped `T_ROB1` via the exact same RWS call `gofa-rapid-exec`'s `stop` action uses (no motion
involved) and polled task state immediately after: `T_ROB1` → `excstate: stopped`, while
`SC_CBC` and `T_GOFA_LED` (both `semistatic`) stayed `excstate: started` throughout. This is the
empirical basis for the `BackgroundLed.mod` design (see `CLAUDE.md`) — not an assumption from
ABB's task-type docs, an actual live test.

**Confirmed live: RWS cannot create a new task instance, only RobotStudio can.**
`GET /rw/cfg/sys/CAB_TASKS/attributes` gives the full 17-attribute schema for a task config
instance (all optional, sensible inits — `Type` even defaults to `SEMISTATIC` already). `OPTIONS`
on both `/rw/cfg/sys/CAB_TASKS/instances` and a named existing instance report `Allow:
GET,POST,DELETE,OPTIONS`, which looked like the familiar "Allow header is technically right, you
just have the wrong URL shape" pattern already solved for `loadmod`/`/set-value` elsewhere in
this project. It isn't, this time: four variants (`POST .../instances` with `Name=T_LED&
Entry=main`; same with `Accept: application/hal+json;v=2.0`; `POST .../instances?action=add`;
`POST .../CAB_TASKS?action=create-instance`) all gave a clean, consistent `405 HTTP method not
supported by resource`, with zero side effects each time. Creating a new task appears to be a
genuinely structural operation (stack allocation + boot-time registration) that RWS's config API
isn't built to hot-provision — RobotStudio's offline Task-configuration UI plus a controller
restart remains the only path found.

**EGM [3124-1] is also installed** (same `GET /rw/system` options list) — this is relevant to
the pose-subscription gap documented below: continuous Cartesian/joint streaming isn't
available over RWS's subscription system, and EGM (Externally Guided Motion, UDP-based) is
ABB's actual mechanism for that. It sat unused for a while during the pose-polling investigation,
then got built and live-verified: **`gofa-egm`** (Node-RED node, `node-red-contrib-abb-gofa`)
streams joint positions over EGM UDP/protobuf at sub-10ms latency, confirmed live with real
motion. Needs `rapid/MainModuleEGM.mod` loaded (a sibling of the palette's default
`MainModule.mod`, not a merge) plus a one-time UDPUC `EGM_PC` transmission-protocol config —
see the top-level `CLAUDE.md`'s EGM section and the `project_egm_node_red_integration_plan`
memory for the full design/live-test history, including two live-disproven assumptions
(`\CommTimeout` is not self-healing; module swaps need an explicit `unloadmod` first).
`gofa-subscribe-pose` still exists and still polls at 500ms — EGM is a separate, opt-in path
for when sub-10ms actually matters, not a replacement for it.

---

## RobotWare Options & Licensing — corrections

**`RobotStudio Connect [3119-1]` is not "PC Interface" and is not about the RWS REST API.**
Per the product manual: it "allows RobotStudio to connect to the robot using the public
network interface (WAN)" — i.e. it's about the **RobotStudio desktop application** reaching
the controller over a network beyond the local service port. "PC Interface" is the old
IRC5-era option name (`616-1`) for a *different*, non-HTTP protocol (PC SDK) — neither name
has anything to do with Robot Web Services.

**Robot Web Services itself is a standard, base-included RobotWare feature**, listed in the
manual's "Communications technology" section alongside socket messaging — no option/license
attaches to it. If an RWS endpoint 404s, look for an OmniCore RWS-2.0-vs-documented-RWS-1.0
path/shape difference first (see the `abb-rws` skill's generic-symbol-data investigation)
before assuming a missing license — that assumption was made once on this project, stated as
fact without a real source, and was wrong.

**Second, independent confirmation** (RobotStudio's own offline documentation package,
`ABB.RobotWareDoc.OmniCore-7.10`, Application Manual "Controller Software" 3HAC066554):
zero mentions of "Robot Web Services" or "RWS" anywhere in that manual (177 pages) or in the
System Parameters manual 3HAC065041 (857 pages) — confirms the REST API isn't documented in
RobotWare's bundled/offline docs at all (it's Developer Center-only, online). `RobotStudio
Connect [3119-1]` does turn up twice there, and both mentions are consistent with the product
manual: it's what **RAPID Message Queue** (task-to-task or task-to-PC-application messaging
via PC SDK) runs on, alongside `Multitasking [3114-1]` — still nothing to do with RWS.

*If you download more RobotWare doc packages later looking for the RWS REST API reference:
don't bother checking the RobotWare Manuals bundle (Controller Software / System Parameters /
RAPID references) — checked and confirmed empty for this. The `abb-rws` skill's Developer
Center source is the only place this project has found real RWS 2.0 API detail.*

---

## RAPID File System Paths

| Alias | Description |
|-------|-------------|
| `HOME:` | User home on controller |
| `HOME:/Programs/` | Default program directory |

Upload files via RWS fileservice: `PUT https://<ip>/fileservice/$HOME/Programs/<filename>`

---

## First-Run Checklist (after .mod upload)

1. FlexPendant → key switch to **AUTO**
2. Enable motors (or use `gofa-motor` node: `motoron`)
3. Program Editor → Load → `$HOME/Programs/MainModule.mod`
4. PP to Main → **Play**
5. Robot now listens on TCP port 1025 for socket commands
