---
name: project-setup-and-mod-edit-nodes
description: "gofa-setup (one-click init) + gofa-mod-edit (in-dialog file editor) built 2026-07-15 — NOT live-verified, robot was down; two specific live checks pending"
metadata: 
  node_type: memory
  type: project
  originSessionId: b9996023-04d2-4c36-afe6-b2dabdd46e3f
---

Built 2026-07-15 (uncommitted at time of writing), while the robot was down ([[project-socket-server-stuck-2026-07-15]]):

- **gofa-setup** — one-click init sequence (preflight Auto-mode check → stop → unload sibling module → upload bundled .mod with SERVER_IP sync → loadmod → resetpp → motors on → verified start → socket PING). Per-step report; `outputPayload` defaults **true** (unlike every other node). Module files read from the *package's* `rapid/` dir (synced by prepack.js). Timings live on `node._t` so tests can shrink them. Example flow: `flows/setup_flow.json`.
- **gofa-mod-edit** — edit controller-disk files in the node's edit dialog (ace editor via `RED.editor.createEditor`, function-node pattern); admin endpoints `/gofa-mod-edit/:id/files|file` (:id = deployed gofa-robot config node id). Built by a fork agent in a worktree, merged by hand (package.json/test.js/READMEs conflict with gofa-setup's edits).

**`gofa-mod-edit` live-verified 2026-07-15 (later same day, robot back on RWS at 192.168.1.103):** directory listing is `<li class="fs-file" title="<name>">` — name lives in the `title` attribute (the parser's first-choice path; anchor text is empty, name only in `href`), plus `fs-cdate`/`fs-mdate`/`fs-size`/`fs-readonly` spans. `parseFileList` returned all real files correctly. Full cycle driven through the REAL node file: upload (SERVER_IP synced 1.2.3.4 → robot IP, confirmed by readback), re-list shows the file, `DELETE /fileservice/<path>` → `204` then `404` on GET — **fileservice DELETE confirmed working, first RWS file-delete confirmed in this project** (nothing in the palette uses it yet — candidate for a gofa-file-delete node or mod-edit dialog button). `fs-dir` shape still unobserved (no subdirectories existed to test against).

**`gofa-setup` live-verified end-to-end 2026-07-15 (same day, user-requested), from a true first-run state:** wiped first (unloadmod MainModuleEGM, fileservice DELETE both .mod files), then the REAL node file ran the full sequence in **2.4s** — upload (45131B, SERVER_IP synced) → loadmod → resetpp → motors on (from motoroff) → start → PING OK, independently re-verified (motoron/running/OK:PING/module+file present). This run also recovered the [[project-socket-server-stuck-2026-07-15]] robot.

**Live bug found & fixed during this:** RWS reports `opmode` **UPPERCASE** (`"AUTO"`), unlike `ctrlstate`/`ctrlexecstate` (lowercase) — CLAUDE.md's endpoint table says lowercase `auto`, which is wrong for opmode. gofa-setup's preflight now compares case-insensitively; test fake's default opmode is now `'AUTO'` to lock it. **Check any future code comparing opmode for the same trap** (gofa-status only reports, doesn't compare — safe).

**Gotcha rediscovered:** the repo `.gitignore` is allowlist-style (`*` then `!` entries) — any new `flows/*.json` must be explicitly un-ignored or it silently never gets committed.
