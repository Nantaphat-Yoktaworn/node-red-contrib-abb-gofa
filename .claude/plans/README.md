# Project plans (portable snapshot)

Copies of every Claude Code plan written for this project, normally stored outside the repo at
`~/.claude/plans/` (global, not project-scoped, not tied to a working directory — so nothing
here would otherwise travel with a clone). Renamed from their original auto-generated slugs to
descriptive names. Useful as design-history/rationale for features already built, not as active
todo lists.

| File | What it covers |
|---|---|
| `autonomous-sequence-plan.md` | Standalone RAPID sequence runner (`AutoSequence.mod`) — final approved design |
| `teach-workflow-flow-plan.md` | Physical-button controlled, safety-gated teach workflow flow |
| `on-robot-point-storage.md` | Storing saved points on the robot's own disk instead of local `points.json` |
| `update-demo-flow-regroup.md` | Regrouping `flows/gofa_demo_flow.json` by protocol instead of function |
| `ip-auto-discovery-deferred.md` | IP auto-discovery for `check-status.js` — considered, deferred |
| `sequencer-node-improvements-plan.md` | `gofa-sequencer`/`gofa-stop-seq` fixes: immediate stop, loop count, ping-pong, startStep |
| `egm-node-split-plan.md` | Splitting `gofa-egm` into session-control + `gofa-egm-move` movement node — implemented, see the `project_egm_node_red_integration_plan` memory |
| `payload-support-audit-plan.md` | Audit of `msg.payload → node property → default` support across all nodes, HTML help updates, release packaging |
| `server-ip-hardcode-fix-plan.md` | Removing the hardcoded `SERVER_IP` from `rapid/MainModule.mod` — superseded by `gofa-upload-mod`'s auto-patch, see `CLAUDE.md`'s SERVER_IP note |
| `dashboard-flow-plan.md` | Building `flows/dashboard_flow.json` (node-red-dashboard UI for the palette) |
| `rebuild-palette-flow-plan.md` | Rebuilding `flows/gofa_demo_flow.json`/`robot_palette_flow.json` to wire in all node types |
