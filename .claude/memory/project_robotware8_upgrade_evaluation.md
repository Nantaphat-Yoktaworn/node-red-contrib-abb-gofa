---
name: project-robotware8-upgrade-evaluation
description: Findings from evaluating a RobotWare 7.21.0 -> 8.1.1 controller upgrade for this project
metadata: 
  node_type: memory
  type: project
  originSessionId: 58ab807b-429c-4693-a7f1-105ef986edca
---

Robot controller currently runs RobotWare 7.21.0+229 (OmniCore C30); ABB offers an upgrade to RobotWare 8.1.1. Evaluated 2026-07-06 by reading ABB's own diff doc, "Changed software features for OmniCore and RobotWare 8" (3HAC098573-001, Rev D) — not guessed from general knowledge.

**Why this matters:** the project's RWS integration leans heavily on RobotWare-7-specific mastership behavior and a physical-ASI-button teach workflow, both of which change materially in RobotWare 8. This isn't a routine version bump — it changes correctness assumptions baked into the code, not just cosmetic API paths.

Key findings:
- **Mastership is replaced wholesale by a new "control station" write-access model in RW8** (`POST /rw/controlstation/writeaccess/request`/`/release` + one-time `register/local`/`register/remote`, write access now persistent across disconnects/restarts/opmode changes). `GoFaRobotNode.prototype.withMastership()` (`gofa-robot.js`), used by `gofa-rapid-exec`'s `resetpp`, is built entirely around RW7's `/rw/mastership/edit/...` pair and would need a real rewrite, not a path tweak, to run on RW8.
- **The documented, confirmed-working physical teach workflow (`flows/teach_workflow_flow.json`, ASI button -> `gofa-leadthrough-enable` -> `gofa-save-point`) may not survive the upgrade.** RW8's own doc states Lead Through can no longer be enabled via the ASI button (must go through the FlexPendant app) and that ASI-initiated RAPID motion breaks ISO10218-1:2025 compliance. Whether this only affects the ASI's native onboard function (vs. this project's approach of reading `Asi1Button1/2` as a plain DI and driving lead-through from Node-RED via RWS) is NOT clarified in ABB's doc — ambiguous, would need live re-testing on an upgraded controller, not an assumption either way.
- **Does not fix the confirmed-dead generic RWS RAPID symbol read/write endpoint** (see [[project-rws-symbol-write-confirmed-impossible]] if that memory exists, or the `abb-rws` skill / CLAUDE.md "RAPID symbol data note"). ABB's RW8 diff doc doesn't mention the `/rw/rapid/symbol(s)` API at all — no evidence it's fixed, no evidence it's unchanged. Genuinely unconfirmed either way.
- **Not an in-place upgrade** — RW7 backups/snapshots/configs/add-ins are incompatible with RW8; it's effectively a full reinstall (new virtual controller, regenerate system package, push to physical controller). Downgrade path exists but must go 8.1 -> 8.0 -> 7, not direct, or safety sync is lost.
- The project's TCP socket layer (`MainModule.mod`'s own `SocketAccept`/`SocketSend`, all the `GETVAR`/`SETVAR`/`GOTO`/jog commands) is NOT part of this RWS write-access change and should be unaffected either way — this is RAPID-internal, not gated by the new control-station API.

**How to apply:** don't recommend or perform this upgrade casually. Before ever executing it: (1) budget real time to port `withMastership`/`gofa-rapid-exec` to the control-station API, (2) re-verify the ASI teach workflow live on a test/upgraded controller before trusting it still works, (3) don't expect it to unblock the RWS variable read/write gap — treat that as still unsolved post-upgrade unless re-tested. If the user's motivation is ISO10218-1:2025 compliance specifically, that's the one clear, confirmed benefit; otherwise there's little upside for this project as it stands today.
