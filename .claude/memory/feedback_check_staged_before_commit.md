---
name: feedback-check-staged-before-commit
description: "Before running git commit, check for pre-existing staged changes unrelated to the current task — git add on specific files doesn't protect against other things already sitting in the index."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4d388321-7937-4a4f-b555-4566ce0287d8
---

Always inspect `git status`/`git diff --cached` for changes staged by something other than
you (a prior session, the user, tooling) before committing — even when you only ran
`git add <specific files>` for your own work. `git commit` (without `-a` or a pathspec) commits
the **entire index**, not just what you just added, so anything already staged rides along
silently.

**Why:** In this project, `rapid/GoFaControl.pgf` was already staged for deletion (along with a
matching `.gitignore` line change) before a task began. The task's own changes were staged with
`git add <5 specific files>`, deliberately leaving the pre-existing deletion untouched — but the
subsequent `git commit` still swept it in, because it was already in the index. This happened
right after explicitly telling the user "I'll leave those alone."

**How to apply:** Before any commit, run `git status` and `git diff --cached --stat` and account
for every staged file, not just the ones from the current task. If something unexplained is
staged, ask the user whether it's intentional before committing — don't assume `git add <my
files>` scopes the commit to just those files.
