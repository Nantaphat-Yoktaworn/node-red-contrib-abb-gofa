---
name: feedback-search-vendor-docs-before-confirmed-impossible
description: "Before writing 'confirmed impossible' into project docs after several live 405/404s, web-search ABB's current forum/docs — don't stop at repeated identical-looking failures"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2c91e9b1-4291-4119-a02a-ea89dc41f357
---

Don't conclude an RWS endpoint/action is permanently unsupported just because several request variants (path-based, query-action, alternate verb, alternate Accept header) all return the same error. If every variant shares the same wrong resource/action name, they aren't actually independent evidence — they're the same wrong guess dressed up differently. Run a `WebSearch`/`WebFetch` against ABB's current developer center and community forum (tech-community.robotics.abb.com, forums.robotstudio.com) before writing a "confirmed impossible" claim into `CLAUDE.md`/a skill/memory.

**Why**: hit live 2026-07-07 — `gofa-do-write` returned `405` on `POST /rw/iosystem/signals/{name}/set` across 6 variants (path-based `/set`, IRC5 `?action=set`, direct `PUT`, `hal+json` Accept, `/simulated`, and an `OPTIONS` probe confirming no POST at all). This looked exactly like the earlier, *actually*-confirmed-impossible RAPID `/rw/rapid/symbols` case (see [[project-robot-live-test-log]]), so it got written up the same way — a plausible-sounding "this firmware's iosystem resource has no RWS write path at all" claim, added to `CLAUDE.md` and the `abb-rws` skill. The user pushed back ("did you search only yet? for more info") and a 2-minute web search of ABB's own community forum immediately surfaced the real action name, `/set-value` (not `/set` — a genuinely different resource, not a variant of anything already tried). RWS could write I/O the whole time; the endpoint name in this project's own docs was simply wrong, probably never live-verified when first written.

**How to apply**: the `abb-rws` skill already has a "verify before building" section that says to cite a real source before a root-cause claim — that section exists *because of* an earlier, similar mistake (the RAPID symbol/"PC Interface option" misdiagnosis), and got skipped again here. Treat "identical error across several variants" as a prompt to search current vendor docs, not as the final word — especially before writing a "corrected"/"confirmed impossible" note into project documentation. See [[dsqc1030-scalable-io-addressing]] for the specific case this happened on.
