'use strict';
var WS = require('ws');

module.exports = function(RED) {
    function GoFaSubscribeStateNode(config) {
        RED.nodes.createNode(this, config);
        this.robot   = RED.nodes.getNode(config.robot);
        this.oneshot = !!config.oneshot;
        var node = this;
        node._ws      = null;
        node._pollkey = null;
        node._stopped = false;

        function startSubscription() {
            if (!node.robot) { node.error('No robot configured'); return; }
            if (node._ws)    { return; }
            var robot        = node.robot;
            var resourcePath = '/rw/panel/ctrl-state;ctrlstate';
            var priority     = 1;

            node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });

            var subscribeBody = 'resources=1&1=' + encodeURIComponent(resourcePath) + '&1-p=' + priority;
            robot.requestRaw('POST', '/subscription', subscribeBody, {
                contentType: 'application/x-www-form-urlencoded;v=2.0'
            }).then(function(res) {
                if (res.statusCode !== 201) throw new Error('Subscription failed: HTTP ' + res.statusCode);
                return robot.getCookie().then(function(cookie) {
                    return { location: res.headers.location, cookie: cookie };
                });
            }).then(function(sub) {
                if (node._stopped) {
                    // Node was closed while the subscribe POST was still in flight — close() already
                    // ran and couldn't clean this up (node._pollkey was still null at that time).
                    // Best-effort delete the now-orphaned subscription ourselves.
                    var pk = sub.location.split('/poll/').pop();
                    node.robot.requestRaw('DELETE', '/subscription/' + pk, null, {}).catch(function(){});
                    return;
                }
                node._pollkey = sub.location.split('/poll/').pop();
                var ws = new WS(sub.location, ['rws_subscription'], {
                    rejectUnauthorized: false,
                    headers: { Cookie: sub.cookie || '' }
                });
                node._ws = ws;
                ws.on('open', function() {
                    node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                    robot.rwsGet('/rw/panel/ctrl-state').then(function(body) {
                        var m = body.match(/class="ctrlstate">([^<]+)</);
                        if (m) {
                            var state = m[1].trim();
                            node.status({ fill: 'green', shape: 'dot', text: state });
                            node.send({ payload: { ok: true, state: state } });
                        }
                    }).catch(function() {});
                });
                ws.on('message', function(data) {
                    var str = data.toString();
                    var m = str.match(/class="ctrlstate">([^<]+)</);
                    if (m) {
                        var state = m[1].trim();
                        node.status({ fill: 'green', shape: 'dot', text: state });
                        node.send({ payload: { ok: true, state: state } });
                    }
                });
                ws.on('error', function(err) { node.error(err); });
                ws.on('close', function() {
                    if (node._ws) {
                        node._ws = null;
                        if (!node._stopped) {
                            node.status({ fill: 'yellow', shape: 'ring', text: 'reconnecting...' });
                            setTimeout(function() { if (!node._stopped) startSubscription(); }, 3000);
                        } else {
                            node.status({ fill: 'grey', shape: 'ring', text: 'disconnected' });
                        }
                    }
                });
            }).catch(function(err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err);
            });
        }

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured'); return done(); }
            if (node.oneshot) {
                node.status({ fill: 'yellow', shape: 'ring', text: 'reading' });
                node.robot.rwsGet('/rw/panel/ctrl-state').then(function(body) {
                    var m = body.match(/class="ctrlstate">([^<]+)</);
                    if (m) {
                        var state = m[1].trim();
                        node.status({ fill: 'green', shape: 'dot', text: state });
                        node.send({ payload: { ok: true, state: state } });
                    }
                }).catch(function(err) {
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err);
                });
            } else if (node._ws) {
                node.robot.rwsGet('/rw/panel/ctrl-state').then(function(body) {
                    var m = body.match(/class="ctrlstate">([^<]+)</);
                    if (m) {
                        var state = m[1].trim();
                        node.status({ fill: 'green', shape: 'dot', text: state });
                        node.send({ payload: { ok: true, state: state } });
                    }
                }).catch(function(err) { node.error(err); });
            } else {
                startSubscription();
            }
            done();
        });

        node.on('close', function(done) {
            node._stopped = true;
            var ws = node._ws;
            node._ws = null;
            if (ws) { ws.terminate(); }
            if (node._pollkey && node.robot) {
                var pk = node._pollkey;
                node._pollkey = null;
                node.robot.requestRaw('DELETE', '/subscription/' + pk, null, {})
                    .catch(function(){})
                    .then(function(){ done(); });
            } else { done(); }
        });
    }
    RED.nodes.registerType('gofa-subscribe-state', GoFaSubscribeStateNode);
};
