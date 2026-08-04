'use strict';
// Best-effort DELETE of the RWS subscription this node currently holds, clearing
// node._pollkey first so it can't be deleted twice.
//
// Needed in two places by every gofa-subscribe-* node that opens a WebSocket:
//
//   1. node 'close' (redeploy/stop) — the obvious one.
//   2. BEFORE re-subscribing on the WS reconnect path. This is the one that was
//      missing: ws.on('close') schedules startSubscription() again, which POSTs a
//      fresh /subscription and overwrites node._pollkey — orphaning the previous
//      subscription on the controller with nothing left holding its key. Those
//      accumulate, and OmniCore only allows 19 concurrent sessions once any WS
//      subscription is active (see gofa-robot.js logout()), so a flaky link
//      eventually exhausts the pool and locks the FlexPendant out with "too many
//      device login".
//
// Never rejects — cleanup failure must not block a reconnect or a redeploy.
module.exports = function dropSubscription(node) {
    var pollkey = node._pollkey;
    if (!pollkey || !node.robot) return Promise.resolve();
    node._pollkey = null;
    return node.robot.requestRaw('DELETE', '/subscription/' + pollkey, null, {})
        .then(function() {}, function() {});
};
