---
name: project_option_presence_checks_2026-07-24
description: Live-verified whether Robot Control Mate, Collaborative Speed Control add-in, and Force control Standard for GoFa are present on this controller — and the compile-test method used to settle the ambiguous one
metadata:
  type: project
---

User provided three ABB manuals (`3HAC073107` Robot Control Mate, `3HAC091309` Collaborative
Speed Control add-in, `3HAC083267` Force control Standard for GoFa) and asked to confirm live
whether each feature is actually present on this lab's controller. Full detail and the
reusable methodology are in the `abb-rws` skill's version-snapshot section — this memory is
the "why/what happened" companion.

**Robot Control Mate (`3065-1`) — NOT present.** Absent from the `GET /rw/system` options list
(33 entries). Went further than a list-check: the manual documents the web HMI's exact URL
(`https://<ip>/docs/RCM.html`, and it even names WAN-port access specifically — consistent
with [[project_wan_port_actual_wiring]]). Hit it live with real `Admin`/`robotics` auth:
`404 "Cannot find document"` — a genuine missing-resource response from the controller, not
just RWS's generic auth wall (which would 401 regardless of whether the doc existed). Two
independent confirmations, both negative.

**Collaborative Speed Control add-in — present.** The manual says it auto-installs whenever
any of `3313-1 Lead-through device`, `3051-X` (safety laser scanner), or `3143-1 Collab. speed
control` is licensed. This controller has `Collaborative Speed Control Base` and `Leadthrough`
in its options list — both qualifying triggers — and `GET /rw/system/products` independently
lists `CollaborativeSpeedControl` v1.3.2 as an installed product component. Straightforward,
no ambiguity.

**Force control Standard for GoFa — present, but this one needed a real test, not just a list
check.** Not named anywhere in the `/rw/system` options list. But `GET
/rw/cfg/MOC/FC_MASTER/instances` showed a real `fc_master1` instance (`valid: true`, all 6
joints mapped) — inconclusive on its own, since the referenced `fc_sensor1` had every value at
factory-neutral defaults (scaling factors all `1`, zero position, identity orientation), which
reads as much like baseline data-model config (GoFa's hardware always has joint torque sensors
used for other things, e.g. SafeMove) as it does an actually-purchased feature. **Settled with
a live compile-test**, since RobotWare gates unlicensed-option RAPID instructions at compile
time: uploaded a tiny module using the Force Control manual's own example verbatim (`FCAct
tool1; WaitTime 1; FCDeact;` with the matching `tooldata` declaration), `loadmod`'d it via
`mastership-test.js` — clean `200` with `"loaded-module": "FCTest"`, confirmed loaded via `GET
/rw/rapid/tasks/T_ROB1/modules`, then `unloadmod` + fileservice `DELETE` to clean up. A
licensing-blocked instruction would have failed the compile, not silently degraded — so this is
as close to definitive as a black-box RWS test gets.

**Reusable finding: fileservice `DELETE` needs an explicit `Accept:
application/xhtml+xml;v=2.0` header or it 406s.** Hit this live doing cleanup — a bare curl
`DELETE` with no Accept header got `406`, the same call with the header explicit got a clean
`204`. Every other RWS call in this project already goes through `gofa-robot.js`'s
`requestRaw()`, which always sets this header — only bit because this was a one-off hand-rolled
curl outside that helper, cleaning up a throwaway test file. Worth remembering next time a raw
curl is used for a one-off RWS call instead of the project's own client.

**How to apply:** when asked "does this controller have X" for some ABB feature/add-in whose
option name isn't obviously in the standard options list, don't stop at a `GET /rw/system`
options-list miss — that list is not exhaustive/consistently named for every feature (Force
Control proved this). Check the vendor manual for (a) a direct HTTP artifact only present if
the feature is installed (worked great for Robot Control Mate's `/docs/RCM.html`), or (b) the
feature's own RAPID instructions/config type names, then either check `/rw/system/products` and
config instances for corroborating signal, or — for real certainty — compile-test the actual
RAPID instruction via the `loadmod` method documented in the `abb-rws` skill.
