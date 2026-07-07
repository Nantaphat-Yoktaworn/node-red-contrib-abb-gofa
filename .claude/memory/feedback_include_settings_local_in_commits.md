---
name: feedback-include-settings-local-in-commits
description: "Include .claude/settings.local.json in commits by default in this project — user wants permission-allowlist changes tracked, not left uncommitted"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2c91e9b1-4291-4119-a02a-ea89dc41f357
---

When committing in this project, stage and include `.claude/settings.local.json` along with the task's other changed files, rather than excluding it as "unrelated."

**Why:** After a commit that deliberately left `.claude/settings.local.json` out (treated as incidental permission-prompt noise, per [[feedback-check-staged-before-commit]]'s general caution about unrelated staged files), the user explicitly said to include it next time. So in this project it's not noise to leave behind — track it like any other working-tree change.

**How to apply:** Default to `git add`-ing `.claude/settings.local.json` whenever it has pending changes at commit time, unless the user says otherwise for a specific commit. Still fine to call out in the commit message/summary that it's a permission-allowlist update, separate from the substantive change.
