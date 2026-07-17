---
name: project_mobile_pwa_dashboard_branch
description: "Local-only branch feature/mobile-pwa-dashboard (3 commits, tip 74841b8) — untested Dashboard 2.0 PWA tab, deliberately not pushed/merged; main since deleted dashboard_flow.json entirely (8e97ffe), so this is no longer a simple merge"
metadata: 
  node_type: memory
  type: project
  originSessionId: e2e385a9-0730-4be8-8b06-2b3c86c1a2dc
---

Branch `feature/mobile-pwa-dashboard` exists **only in the local clone**, tip commit
`74841b8`. Deleted from GitHub on request (2026-07-16) — kept local-only, not pushed, not
merged into `main`. `main` is at `d50d405` (2.2.4), unaware of any of this branch's content.

**Contents (3 commits, based off `main`@d50d405):**
- `584ef6d` — `gofa-file` gains a real "list" action (RWS directory listing, reuses
  `gofa-mod-edit.js`'s `parseFileList`), plus a comment fix on that parser. Tested, safe,
  no concerns — could be cherry-picked/merged independently of the rest.
- `99b870d` — fixes the same `outputPayload`/stale-IP/stale-version bugs in
  `dashboard_flow.json` as the teach/demo flow fixes, **plus** adds a new second tab "GoFa
  Mobile PWA (RAPID control)" built on `@flowfuse/node-red-dashboard` (Dashboard 2.0),
  scoped to motors on/off, reset PP, start/stop RAPID, load/unload module with a live
  `.mod`/`.modx` dropdown.
- `74841b8` — version bump to 2.2.5 (uncommitted-to-registry; 2.2.4 is the latest published
  npm version as of this branch's creation).

**Why local-only:** the Dashboard 2.0 (`ui-base`/`ui-page`/`ui-group`/`ui-button`/
`ui-dropdown`/`ui-text`) node schemas were verified against the real
`@flowfuse/node-red-dashboard` v1.30.2 GitHub source (not memory) and two of its own real
example flows, since this dev environment has no live Dashboard 2.0 install to test
import/render against. The underlying GoFa control logic reuses the same well-tested
`gofa-motor`/`gofa-rapid-exec`/`gofa-file` node patterns as every other flow in this repo —
only the `ui-*` widget JSON is unverified. User asked to hold this back from `main` and
GitHub until they've tested a real import.

**How to apply:** don't push this branch to GitHub or merge it into `main` unless the user
explicitly asks again — they deliberately reversed course on an earlier push+ask-to-merge
default (see [[feedback_always_ask_before_push_or_merge]]) specifically for this branch. If
asked to resume this work: `git log feature/mobile-pwa-dashboard` to recall exact state,
check whether `main` has moved since `d50d405` (rebase may be needed), and ask whether the
user already test-imported the PWA tab into a real Node-RED + Dashboard 2.0 instance before
touching it further — that answer determines whether this is "polish it" or "debug the
import" work.

**Update 2026-07-16 (same day, commit `8e97ffe`): `flows/dashboard_flow.json` was removed
from `main` entirely**, not just left unfixed. Once `test.js` gained a check requiring every
`flows/*.json` to have `outputPayload:true` on every node, `main`'s stale, never-fixed
`dashboard_flow.json` started failing that check — and the only *fixed* version of the file
lived on this branch, bundled with the unverified PWA tab. Rather than maintain two diverging
copies (a fixed-no-PWA one on `main`, a fixed-with-PWA one on the branch), the file was pulled
off `main` entirely; a plain `outputPayload`-only fix was applied and discarded rather than
committed, specifically to avoid that fork. **This means merging this branch later is no
longer a simple fast-forward-style merge** — `main` no longer has `dashboard_flow.json` at
all, so bringing this branch's version back means re-adding the file fresh (with or without
the PWA tab, whichever the user wants at that point), not resolving a normal two-sided diff.
Check `main`'s current file list for `dashboard_flow.json` before assuming anything about its
state.
