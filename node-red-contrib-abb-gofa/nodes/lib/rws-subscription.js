'use strict';
var WS = require('./ws');
var dropSubscription = require('./drop-subscription');

// C3 (2026-08-04): the RWS subscribe + WebSocket-connect + reconnect mechanics,
// which were triplicated across gofa-subscribe-io/state/elog. Every subtlety
// below was learned live and had to be kept in sync by hand across three copies:
//
//   - queueSubscription() serializes subscription creation across ALL subscribe-*
//     nodes sharing one gofa-robot session. Two nodes POSTing /subscription within
//     milliseconds of each other (auto-injects at deploy time) got a real HTTP 500.
//   - the cookie must come from THIS subscribe response, not a later getCookie()
//     re-fetch — the shared session cookie can be overwritten by another node's
//     concurrent request in between, and the WS upgrade then uses the wrong session.
//   - the stale poll key must be dropped BEFORE re-subscribing, or every reconnect
//     orphans one subscription on the controller (bug 6; the controller caps
//     concurrent sessions at 19 once any WS subscription is active).
//   - a node closed while the subscribe POST is still in flight has to delete the
//     subscription itself; close() ran when _pollkey was still null.
//
// Node-specific behavior stays with the node, via opts:
//   resourcePath  RWS resource to subscribe to
//   priority      RWS subscription priority
//   onMessage(d)  a WS frame arrived
//   onOpen()      the socket is up (optional)
//   onStatus(s)   status object to display (optional)
//   onError(err)  subscribe failed for a reason the node may special-case (optional;
//                 return true to mark it handled and suppress the default node.error)
//   label         short text prefix for status messages (optional)
module.exports = function createSubscription(node, opts) {
    var label = opts.label ? opts.label + ' ' : '';
    function status(fill, shape, text) {
        if (opts.onStatus) opts.onStatus({ fill: fill, shape: shape, text: label + text });
    }

    function start() {
        if (!node.robot) { node.error('No robot configured'); return; }
        if (node._ws) return;
        var robot = node.robot;
        status('yellow', 'ring', 'connecting');

        var body = 'resources=1&1=' + encodeURIComponent(opts.resourcePath) + '&1-p=' + (opts.priority || 1);

        var performSubscribe = function() {
            // Drop any subscription we still hold before creating a new one — the
            // reconnect path arrives here with node._pollkey still set from the
            // connection that just died. See lib/drop-subscription.js.
            return dropSubscription(node).then(function() {
                return robot.requestRaw('POST', '/subscription', body, {
                    contentType: 'application/x-www-form-urlencoded;v=2.0'
                });
            }).then(function(res) {
                if (res.statusCode !== 201) throw new Error('Subscription failed: HTTP ' + res.statusCode);
                return { location: res.headers.location, cookie: res.cookie };
            }).then(function(sub) {
                if (node._stopped) {
                    // Closed while the POST was in flight — close() couldn't clean this
                    // up because _pollkey was still null then. Best-effort delete.
                    var pk = sub.location.split('/poll/').pop();
                    return node.robot.requestRaw('DELETE', '/subscription/' + pk, null, {}).catch(function() {});
                }
                node._pollkey = sub.location.split('/poll/').pop();
                return new Promise(function(resolve) {
                    node._wsTimer = setTimeout(function() {
                        node._wsTimer = null;
                        if (node._stopped) { resolve(); return; }
                        var ws = new WS(sub.location, ['rws_subscription'], {
                            rejectUnauthorized: false,
                            headers: { Cookie: sub.cookie || '' }
                        });
                        node._ws = ws;
                        ws.on('open', function() {
                            status('green', 'dot', 'connected');
                            if (opts.onOpen) opts.onOpen();
                            resolve();
                        });
                        ws.on('message', function(data) { opts.onMessage(data); });
                        ws.on('error', function(err) {
                            node.warn('GoFa WebSocket subscription error: ' + err.message);
                            resolve();
                        });
                        ws.on('close', function() {
                            resolve();
                            if (node._ws) {
                                node._ws = null;
                                if (!node._stopped) {
                                    status('yellow', 'ring', 'reconnecting...');
                                    setTimeout(function() { if (!node._stopped) start(); }, 3000);
                                } else {
                                    status('grey', 'ring', 'disconnected');
                                }
                            }
                        });
                    }, 100);
                });
            });
        };

        var p = typeof robot.queueSubscription === 'function'
            ? robot.queueSubscription(performSubscribe)
            : performSubscribe();

        p.catch(function(err) {
            if (opts.onError && opts.onError(err) === true) return; // node handled it
            status('red', 'ring', 'error');
            node.error(err);
        });
    }

    // Tears everything down and releases the controller-side subscription.
    function stop(callback) {
        if (node._wsTimer) { clearTimeout(node._wsTimer); node._wsTimer = null; }
        if (node._pollTimer) { clearInterval(node._pollTimer); node._pollTimer = null; }
        var ws = node._ws;
        node._ws = null;
        if (ws) ws.terminate();
        dropSubscription(node).then(function() { if (callback) callback(); });
    }

    return { start: start, stop: stop };
};
