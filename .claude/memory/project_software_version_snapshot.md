---
name: project-software-version-snapshot
description: "Confirmed live software/firmware versions for this GoFa setup as of 2026-07-07 — RobotWare 7.21.0+229, RWS 2.0, RobotStudio 2026.2 (26.2.11700.0), Node-RED 5.0.1"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c91e9b1-4291-4119-a02a-ea89dc41f357
---

Pulled live from the controller (`GET /rw/system` + `GET /rw/system/products`) rather than assumed, specifically to avoid repeating the RWS-1.0-vs-2.0 documentation mistake already made once in this project (see [[feedback-search-vendor-docs-before-confirmed-impossible]]).

**Update 2026-07-16** ([[project_docs_audit_2026-07-16]]): Node.js and Node-RED below are
stale — re-confirmed as `v24.18.0` and `5.0.0` respectively on the dev machine this pass.
RobotWare/controller identity re-confirmed unchanged live. RobotOS/Robots/ASI/etc. sub-versions
and RobotStudio not reverified this pass. Current authoritative values are in CLAUDE.md's
"Software versions" section, not this frozen snapshot.

| | |
|---|---|
| RobotWare (RobotControl) | `7.21.0+229` |
| RobotOS | `18.1.0+48` |
| Robots | `1.21.0+42` |
| ASI | `1.0.10` |
| CollaborativeSpeedControl | `1.3.2` |
| Wizard | `1.7.3` |
| `robapi-compatibility-revision` | `5` |
| RWS protocol generation | `2.0` (confirmed via ABB's own community forum + this project's own live behavior — path-based actions, `/set-value`, `hal+json;v=2.0`) |
| Controller | OmniCore C30 Type A, identity `15000-501318` |
| Robot | CRB 15000-12/1.27 (GoFa 12) |
| RobotStudio (RD2's engineering tool) | `2026.2`, build `26.2.11700.0` |
| Node-RED | `5.0.1` |
| Node.js | `v22.9.0` |

Installed RobotWare options relevant to this project: `3024-1 EtherNet/IP Scanner`, `3024-2 EtherNet/IP Adapter`, `3114-1 Multitasking`, `3124-1 Externally Guided Motion (EGM)` (licensed but unused — real answer for continuous pose streaming if `gofa-subscribe-pose`'s poll ever needs replacing), `3043-3 SafeMove Collaborative`, `Leadthrough`, `ASI`, `Collaborative Speed Control Base`, `Wizard`, `3119-1 RobotStudio Connect` (confirmed unrelated to RWS).

**2026-07-24**: also confirmed live — Robot Control Mate (`3065-1`) NOT present; Collaborative Speed Control add-in and Force control Standard for GoFa both present (Force Control isn't named in the options list at all — had to be confirmed with a real compile-test, not a list check). See [[project_option_presence_checks_2026-07-24]] and the `abb-rws` skill.

**DSQC1030 firmware/module revision — deferred, not resolved.** No version field on `/rw/iosystem/devices/{name}` or its EIO config instance, so RWS can't answer this. Tried to find the exact RobotStudio menu path via ABB's own manuals (Scalable I/O 3HAC070208, I/O Engineering 3HAC082346) — both PDF downloads 403'd or came back corrupted/compressed on every mirror tried (library.e.abb.com, uzivatelskadokumentace.cz, icdn.tradew.com). Best guess, unconfirmed: Controller tab → I/O Engineering → right-click `ABB_Scalable_IO` → Properties (EtherNet/IP's standard CIP Identity object carries a revision field, likely surfaced there) or a physical label on the unit. RD2 couldn't find it and asked to skip — don't re-attempt the same PDF fetches next time; if this becomes needed again, try a fresh search rather than the exact URLs already tried here.

**RobotStudio 2026.2 release notes aren't public yet** — searched `library.e.abb.com`/`search.abb.com`, only found up to 2026.1 (build `26.1.11664.0`). If RobotStudio's I/O config UI ever doesn't match what this project's docs describe, ask RD2 for `Help → About` build info or the release notes if ABB publishes them later.

**How to apply:** don't re-derive this from scratch — re-pull only if something seems off after an ABB software update (`GET /rw/system` + `/rw/system/products` on the controller, RobotStudio's `Help → About` for engineering-tool version, `node --version`/`npm ls -g node-red` on the Node-RED host). Full detail duplicated in the `abb-rws` skill and `CLAUDE.md`'s "Software versions" section.
