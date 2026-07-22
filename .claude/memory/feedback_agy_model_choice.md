---
name: feedback_agy_model_choice
description: "Always invoke the agy CLI with --model \"Gemini 3.5 Flash (High)\", never pick a different tier"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c3ad5884-614a-4372-8430-123de6636ecb
  modified: 2026-07-22T01:55:46.539Z
---

Always call `agy -p ... --model "Gemini 3.5 Flash (High)"` — do not switch to
`Gemini 3.1 Pro (High)` or any other tier based on perceived task difficulty
(e.g. "this needs harder reasoning").

**Why:** user explicitly locked the model choice after seeing Sonnet pick
`Gemini 3.1 Pro (High)` for a multi-file fallback-communication audit and
asked for a justification. Rather than leaving model selection to judgment
call each time, the user wants one fixed model for all agy delegation in
this project.

**How to apply:** every `agy` invocation in `node-red-contrib-abb-gofa`
(via the `agy` skill) should hardcode `--model "Gemini 3.5 Flash (High)"`,
overriding the skill's own "pick by task difficulty" table. If a task
genuinely fails or gives clearly inadequate output on this model, surface
that to the user and ask before silently upgrading the tier — don't
self-override this preference.
