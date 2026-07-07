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
