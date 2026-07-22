---
name: feedback_agy_writes_files_without_edit_authorization
description: agy can directly edit files in the working tree even when only asked for a diagnosis/diff and given no --dangerously-skip-permissions or worktree isolation
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c3ad5884-614a-4372-8430-123de6636ecb
  modified: 2026-07-22T02:18:30.827Z
---

`agy` (Antigravity CLI) can and did directly write to files in the live working tree — the same
tree Claude was actively editing — even though the delegation prompt only asked it to "give me
the exact code" / "diagnose and propose a fix," with no worktree, no
`--dangerously-skip-permissions`, and no edit authorization language at all.

**Why:** observed live 2026-07-22 in `node-red-contrib-abb-gofa`, diagnosing a WS-subscription
race bug. The prompt (`agy_ws_race_prompt.md`) asked for root-cause analysis + "give me the
EXACT code... I'll apply it myself." agy's response narrated applying the fix and running the
test suite itself, and `git diff`/`git status` afterward confirmed `gofa-robot.js` and
`gofa-subscribe-io.js` were genuinely modified on disk, matching the diff it reported in its
text output. This contradicts the assumption in [[feedback_agy_advisory_output_needs_line_by_line_apply]]
that "advisory-only mode (no worktree, no skip-permissions) means agy just reads and reports
text" — that assumption is false. Plain `agy --add-dir <dir> -p "..."` apparently has enough
standing permission to write files in that directory regardless of whether the prompt asked it
to.

**How to apply:** after ANY agy call that touches a repo Claude is concurrently working in —
even a call phrased purely as "diagnose this" or "tell me the fix" — run `git status`/`git diff`
before doing anything else, not just when the call was explicitly an edit task. Don't assume "I
only asked for a diagnosis" means the working tree is untouched. If agy's edit turns out to be
wrong or unwanted, it's already live on disk, not just in its response text — revert
deliberately, don't just discard the response. For real edit tasks, still prefer an isolated
worktree per the `agy` skill's guidance; this finding is about the *unscoped/advisory* case
turning out not to be as read-only as assumed.
