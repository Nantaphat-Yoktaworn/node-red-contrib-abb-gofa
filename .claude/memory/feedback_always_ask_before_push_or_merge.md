---
name: always_ask_before_push_or_merge
description: Always ask the user for explicit approval before running git push or git merge in this repo.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 90ad9303-30da-4508-8685-d83927483b20
---

Always ask the user for explicit permission/approval before running any command that pushes
commits to a remote repository (`git push`) or merges branches (`git merge`). Never perform
these actions autonomously.

**Why:** the user works on this repo from multiple machines/sessions. A local branch can be
significantly behind origin without warning — confirmed live 2026-07-10: local `main` was 1
commit ahead but 18 commits behind origin (a full JSON socket-protocol rewrite, IP
auto-discovery, several EGM fixes had landed remotely). A blind push would have been rejected
(non-fast-forward, no data lost that time), but a blind merge/rebase without surfacing the size
and nature of the divergence first would have been the wrong call — see
[[project_robot_current_ip]] for context on how fast this repo's state moves.

**How to apply:** before `git push`, always check `git status`/`git fetch` first. If ahead-only,
confirm before pushing (per this rule). If also behind, do not just rebase/merge silently — show
the user what the divergent commits actually contain (especially anything that looks like an
architecture change) and let them pick the reconciliation strategy (rebase vs merge vs "let me
look first") before touching git.
