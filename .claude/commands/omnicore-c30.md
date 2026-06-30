# OmniCore C30 Type A — Controller Reference

Source: Product manual 3HAC089064-001, Rev F (2026)  
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

- Default IP: `192.168.20.15`
- Port: 443 (HTTPS, self-signed cert — use `-k` with curl)
- Auth: Basic `Admin:robotics` → cookie session (auto-refresh on 401)
- See `/abb-rws` skill for full endpoint reference

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
