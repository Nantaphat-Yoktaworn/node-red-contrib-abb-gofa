---
name: ambiguous-hardware-test-result
description: "When a live robot-test tool call's result is lost/interrupted, check live state immediately and ask for exact observed evidence rather than guessing what happened"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4d388321-7937-4a4f-b555-4566ce0287d8
---

If a tool call driving a live test against the real robot returns an error/gets interrupted and
you don't get its actual output, don't assume either "it didn't run" or "it completed as
intended." Immediately run read-only state checks (`gofa-status`, lead-through status, etc.)
against the live controller, and ask the user precisely what they observed (exact debug sidebar
messages, not just their summary of what happened) before taking any corrective action.

**Why:** In this project, a Bash tool call running a test harness lost its result. The robot
turned out to be mid-sequence (RAPID stopped, about to attempt lead-through). Guessing at the
cause instead of pulling the actual debug messages would have wasted time chasing the wrong
theory — the real bug (traced from the exact debug payload the user pasted back) was a
`gofa-rapid-exec` message-chaining issue, not a timing/race issue as initially suspected from
the vaguer verbal description alone.

**How to apply:** This extends [[feedback_verify_before_building_robot_features]] specifically to
the failure-recovery case: when live-hardware test instrumentation itself fails or is ambiguous,
re-establish ground truth via read-only state queries first, then ask for verbatim
evidence (exact error text, exact debug node output) rather than proceeding on a paraphrase.
