- [Autonomous sequence feature](project_autonomous_sequence_feature.md) — standalone RAPID point-sequencer, ABANDONED — branch deleted, recoverable from commit a5aeada
- [User's learning context](user_learning_context.md) — no defined business use case yet, senior said "learn everything," user wants to enjoy it — favor fun/broad-learning suggestions
- [Public release](reference_public_release.md) — package is PUBLIC since 2026-07-08 (npm + flow library); release process and public-repo rules
- [gofa-egm-python project](project_gofa_egm_python.md) — standalone EGM control project, working end-to-end; egm_minmax silent-clamp gotcha, firewall/UDPUC setup notes
- [EGM Node-RED integration](project_egm_node_red_integration_plan.md) — IMPLEMENTED + published; split into gofa-egm (session) + gofa-egm-move (movement, fallback output), live-verified — no known open bugs
- [Robot's current IP](project_robot_current_ip.md) — 192.168.1.103, reconfirmed 2026-07-16; always verify via /robot-status, don't trust any documented default
- [Docs audit 2026-07-16](project_docs_audit_2026-07-16.md) — full doc-vs-reality sync (commit d589a13): stale IP everywhere, stale Node.js/Node-RED versions, undocumented properties-panel feature, JSON_SOCKET_TRANSITION.md's roadmap was 100% already shipped
- [Always ask before push or merge](feedback_always_ask_before_push_or_merge.md) — confirm with user before any git push/merge; check for remote divergence first, surface what changed if behind
- [Output payload checkbox](project_output_payload_checkbox.md) — implemented + live-verified 2026-07-15 across all 42 nodes; gate.js design, wiring pattern, motion-test strategy
- [gofa-setup + gofa-mod-edit nodes](project_setup_and_mod_edit_nodes.md) — BOTH live-verified 2026-07-15 incl. gofa-setup from a wiped first-run state (2.4s); opmode is UPPERCASE live (fixed); fileservice DELETE works
- [Socket server stuck 2026-07-15](project_socket_server_stuck_2026-07-15.md) — RESOLVED-BY-REINSTALL 2026-07-15 (gofa-setup full reinstall restored socket serving); root cause of the original wedge still unconfirmed
- [Improvement roadmap 2026-07-15](../../ideas/improvement-roadmap.md) — saved plan: version handshake + watchdog flow first; backup flow, mod-edit delete button, virtual controller, MQTT, vision-pick; LoadIdentify safety debt (repo ideas/improvement-roadmap.md)
- [Mobile PWA dashboard branch](project_mobile_pwa_dashboard_branch.md) — feature/mobile-pwa-dashboard, LOCAL ONLY, tip 74841b8; main deleted dashboard_flow.json entirely (8e97ffe) so this is no longer a simple merge; don't push/merge without asking
- [Lead-through TSS violation 2026-07-17](project_leadthrough_tss_violation_2026-07-17.md) — 90515 fixed by manual-mode jog under enabling device, not config/code; also fixed a real HTTP-200-lies bug in gofa-leadthrough.js enable
- [Background LED task 2026-07-17](project_background_led_task.md) — BackgroundLed.mod/T_LED verified against the real deployed teach flow (physical buttons); RWS can't create tasks; ABB's own safety LED overrides (white=activating, yellow=moving) are real, not bugs; fixed a shared-cookie race across all 3 WS-subscribe nodes

Older memories preserved only in this snapshot (pruned from live memory but still referenced by CLAUDE.md and the skills):

- [Verify before building robot features](feedback_verify_before_building_robot_features.md) — curl/socket-test live against the robot before writing node code, and re-test after building
- [Check staged changes before commit](feedback_check_staged_before_commit.md) — git commit takes the whole index, not just files you just `git add`ed
- [Ambiguous hardware test result](feedback_ambiguous_hardware_test_result.md) — check live state first, ask for verbatim debug output, don't guess
- [RobotWare 8 upgrade evaluation](project_robotware8_upgrade_evaluation.md) — mastership rewrite needed, ASI teach-workflow at risk, doesn't fix RWS symbol gap
- [Check robot status before live test](feedback_check_robot_status_before_live_test.md) — always use `/robot-status` skill first unless user gave it; log both
- [Curl mastership needs shared cookie jar](feedback_curl_mastership_needs_shared_cookie_jar.md) — use `/mastership-test` skill instead of hand-rolled curl; explains why
- [Robot live test log](project_robot_live_test_log.md) — running dated log of live RWS/socket tests and outcomes
- [Grep all nodes after shared-internals refactor](feedback_grep_all_nodes_after_shared_internals_refactor.md) — one incomplete gofa-robot.js refactor broke 4 nodes across 2 sessions
- [Manual control doc](reference_manual_control_doc.md) — MANUAL_CONTROL.md has every curl/raw-TCP command, split RWS-always vs socket-needs-RAPID-running
- [Stop Node-RED before controller restart](feedback_stop_nodered_before_controller_restart.md) — leaked RWS sessions (no logout call) can lock out FlexPendant via the 19/70-session cap
- [DSQC1030 Scalable I/O addressing](reference_dsqc1030_scalable_io_addressing.md) — no rotary switches; IP is software-set in RobotStudio, range 192.168.125.100-129
- [Search vendor docs before "confirmed impossible"](feedback_search_vendor_docs_before_confirmed_impossible.md) — repeated identical 405s isn't proof; web-search ABB forums before declaring an RWS endpoint dead
- [Software version snapshot](project_software_version_snapshot.md) — RobotWare 7.21.0+229, RWS 2.0, RobotStudio 2026.2 (26.2.11700.0), confirmed live 2026-07-07; Node.js/Node-RED corrected 2026-07-16 (see docs audit)
- [OmniCore Ethernet Switch section](reference_omnicore_ethernet_switch_section.md) — separate 5-port (X1-X5) switch on back panel, distinct from WAN/LAN/MGMT; no RWS/RAPID API, not a node candidate
- [Robot IP drift](reference_robot_ip_drift.md) — controller IP changes often (even twice in one day); always re-check via /robot-status, never trust a recorded IP
- [StopMove \Quick unsupported](feedback_stopmove_quick_unsupported.md) — fails RAPID consistency check on this controller despite being in ABB's docs; use plain StopMove
- [OmniCore AppStudio investigation](reference_omnicore_appstudio_investigation.md) — persistent FlexPendant dashboard ruled out for now, needs RobotStudio GUI step, not RWS-drivable
- [IP discovery deferred](project_ip_discovery_deferred.md) — check-status.js IP auto-discovery: design sketched and deferred at the time; since built (check-status.js --discover, gofa-robot Discover button)

Note: this robot's real RWS/admin credentials live only in local (non-repo) Claude memory — deliberately never copied here since this repo is public. (Snapshot last synced from live memory: 2026-07-17, after the Background LED task session — added that memory plus two from 2026-07-16/17 that hadn't been synced yet: mobile PWA dashboard branch, lead-through TSS violation.)
