---
name: reference_omnicore_appstudio_investigation
description: "OmniCore App SDK / AppStudio (persistent FlexPendant web-app dashboard) — investigated, ruled out for now, why, and what would be needed to revisit"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b4c0b98-980a-4dc2-b1a3-6218ede82b8f
---

Investigated as a way to give the standalone-sequence feature (see
[[project_autonomous_sequence_feature]]) a persistent FlexPendant dashboard instead of the
RAPID-native `TPReadFK`/`UIMsgBox`/`UINumEntry` sequential-dialog approach.

**Findings**:
- AppStudio / the OmniCore App SDK is free (€0) and does **not** need the RobotWare "FlexPendant
  Interface" option (that's only required for the legacy .NET Screenmaker/FlexPendant SDK path,
  which this controller doesn't have installed — ruled out for licensing reasons alone).
- A real deployed example (`JayCeeON/ABB_OC_FP_WEBAPP` on GitHub) confirmed the app shape:
  `appinfo.xml` manifest (`<WebApp><name>/<icon>/<path>`), plain HTML/CSS/JS, ABB's bundled
  `rws-api/omnicore-rws.js` client exposes `RWS.IO.getSignal/setSignalValue` (same `/set-value`
  mechanism this project already uses), `RWS.Network.get/post` (generic RWS calls, covers
  `fileservice`), and `RWS.Rapid.getData/setValue` (a generic RAPID symbol wrapper — almost
  certainly rides the same `/rw/rapid/symbol/data/...` endpoint already confirmed **404** on this
  controller; never independently re-tested through the JS layer, low priority).
- **Confirmed empirically that raw `fileservice PUT` deployment does not work**: placed a minimal
  `appinfo.xml` + `index.html` directly at `$HOME` on the live controller (`192.168.20.15` at the
  time) — nothing appeared in the FlexPendant's Operate → Dashboard screen. Also confirmed
  `fileservice` cannot create a new subdirectory via `PUT` (`OPTIONS $HOME` only allows
  `GET,DELETE,OPTIONS`) — parent folder must already exist.
- Two ABB forum threads (found via search, both later 404'd on refetch — community platform
  seems to have moved/pruned old threads) corroborated this: one described needing the app to be
  "in the Add-ins list" to show up; another mentioned AppStudio getting its own launcher button
  added to the FlexPendant menu. Together with the empirical null result, this points to a real
  install/registration step through **RobotStudio + the AppStudio add-in** (a GUI tool on a PC,
  not something drivable via RWS/`curl`/fileservice the way everything else in this project is).

**Why ruled out for now**: this project's whole toolchain (Node-RED nodes, `check-status.js`,
`mastership-test.js`) works by scripting RWS/RAPID directly — no step has ever required a human
at a Windows GUI app. Requiring RobotStudio+AppStudio for this one feature breaks that pattern
and can't be automated/tested by an agent the way the rest of this project can.

**How to apply**: the standalone-sequence feature uses the RAPID-native `TPReadFK`/`UIMsgBox`/
`UINumEntry` menu instead (confirmed working live, see [[project_autonomous_sequence_feature]]).
If a persistent dashboard is revisited later: the user would need to install AppStudio via
RobotStudio themselves and do the deploy/registration step manually; an agent could still write
the actual `index.html`/`app.js`/`app.css` content for them to drop into that project — just not
drive the packaging/deployment/registration end of it.
