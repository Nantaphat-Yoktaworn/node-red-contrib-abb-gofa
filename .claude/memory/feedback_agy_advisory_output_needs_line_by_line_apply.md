---
name: feedback_agy_advisory_output_needs_line_by_line_apply
description: "When agy runs in advisory-only mode (no repo write access), hand-transcribing its text output into real files needs the same verify-before-trust discipline as trusting its edits directly"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f19b26e2-3fa2-4d0e-9cd8-e68bc97a7910
---

When delegating to `agy` in advisory-only mode (per the `agy` skill's basic pattern — no
worktree, no `--dangerously-skip-permissions`, agy just reads and reports text), the act of
*applying* its output by hand (via Write/Edit) is itself a place bugs get introduced, separate
from whatever agy got right or wrong.

**Why**: caught live 2026-07-20 building the module-version-handshake feature — while manually
retyping/reconstructing one of agy's two file drafts into a Write call, `waitFor(readExec,
'running', timings.start, 'RAPID')` got mistyped as `waitForExecState('running', timings.start)`
(a function that doesn't exist) in `gofa-setup.js`'s admin-endpoint code path. agy's own draft
had the correct call — this was purely a transcription slip made while applying it, not
something agy got wrong. `node test.js` didn't catch it either, because that specific code path
(the admin HTTP endpoint's duplicate of the runtime logic) has no unit test coverage.

**Why it matters**: it's tempting to treat "I already reviewed agy's draft and it looked right"
as sufficient, and skip re-verifying after transcribing it into the real file. The transcription
step is a second, independent opportunity to introduce an error that review-of-the-draft doesn't
catch.

**How to apply**: after applying any agy advisory output (or any hand-copied/reconstructed code)
to real files, always run a cheap mechanical check before the full test suite — `node -c
<file>` for syntax, `node -e "require('./path')"` for a load-time smoke test (catches
`ReferenceError`s in code paths the test suite doesn't exercise, like admin-only HTTP handlers).
This is a near-zero-cost step that catches an entire class of transcription bugs the test suite
structurally can't see. Don't skip it just because "the draft was already reviewed."

See [[project_module_version_handshake_watchdog]] for the full incident.
