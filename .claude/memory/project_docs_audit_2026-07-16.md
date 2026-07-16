---
name: project_docs_audit_2026-07-16
description: "Full documentation-vs-reality audit completed 2026-07-16 (commit d589a13) — what was stale, what's now current, what's still open"
metadata: 
  node_type: memory
  type: project
  originSessionId: e2e385a9-0730-4be8-8b06-2b3c86c1a2dc
---

Ran a full audit of every doc in the repo (CLAUDE.md, README.md, MANUAL_CONTROL.md,
JSON_SOCKET_TRANSITION.md, the abb-rws/omnicore-c30 skills, ideas/improvement-roadmap.md)
against the actual code and a live robot check, per the user's "make sure all the document
match the actual project current state" request. Fixed in commit `d589a13`.

**Why:** CLAUDE.md hadn't been touched since `dfa0544` (2.1.0) — three releases (2.1.1, 2.2.0,
2.2.1, 2.2.2) had shipped with zero doc updates, including the single biggest feature addition
in the project's history (2.2.0's interactive properties panels, present on all 43 nodes).

**Found and fixed:**
- Robot IP was stale everywhere in prose docs (`192.168.20.33`/`.36`) — actual robot is on a
  completely different subnet now, `192.168.1.103` (confirmed live via `check-status.js
  --json` this session). Fixed in CLAUDE.md's connection table, `check-status.js`/
  `mastership-test.js`'s hardcoded `GOFA_IP` fallback default, the abb-rws/omnicore-c30 skills,
  and MANUAL_CONTROL.md. Reworded the skill files to point at `/robot-status` instead of a
  hardcoded value, since this IP will drift again — see [[project_robot_current_ip]].
- CLAUDE.md's Software versions table: Node.js was `v22.9.0`, actually `v24.18.0` on this
  machine; Node-RED was `5.0.1`, actually `5.0.0` (`npm ls -g node-red`). RobotWare
  `7.21.0+229` re-confirmed unchanged live. RobotStudio version left alone — no way to verify
  it from this environment, marked "unverified" rather than guessed.
- **Biggest gap**: CLAUDE.md had zero documentation of the interactive properties panels
  (2.2.0+) — added a full section explaining the admin-endpoint pattern, that panel buttons
  never call the node's `send()` (so nothing propagates downstream in a deployed flow even
  though the robot really moves), the `adminAuth` exposure, and the `gofa-sequencer` shared-
  state interaction between panel runs and deployed-flow runs.
- `JSON_SOCKET_TRANSITION.md`'s "Phase 2 Roadmap" (13 listed nodes to refactor to structured
  JSON `socketSend()` calls) was actually **100% already shipped** — re-verified every listed
  file's current `socketSend(` call sites. The doc read as an open TODO list; rewrote it as a
  completion record and fixed stale references to an agent scratch directory that isn't part
  of this repo.

**Confirmed accurate, no change needed:** all 43 node `.js` files match CLAUDE.md's node table
and `package.json`'s `node-red.nodes` registry exactly (diffed both ways); README's node table
(an initial narrow grep flagged 9 "missing" nodes — false positive, they're listed in
multi-node slash-separated table rows); `ideas/improvement-roadmap.md`'s open items (module
version handshake, watchdog flow, mod-edit delete button) are all genuinely still unbuilt.

**How to apply:** before trusting any IP/version number in this repo's docs, check whether
it's dated/caveated — several docs now explicitly say "drifts, don't hardcode" rather than
stating a value, which is more sync-proof than a bare number. If asked to re-audit, this
memory + the commit diff is the fast way to see what was already checked recently vs. what's
likely drifted again since.
