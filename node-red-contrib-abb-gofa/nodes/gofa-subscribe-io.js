'use strict';
var gate = require('./lib/gate');
var WS = require('./lib/ws');
var parseSignalList = require('./lib/list-signals');

module.exports = function(RED) {
    function GoFaSubscribeIoNode(config) {
        RED.nodes.createNode(this, config);
        this.robot   = RED.nodes.getNode(config.robot);
        this.signal  = config.signal || 'ABB_Scalable_IO_0_DI1';
        this.oneshot = !!config.oneshot;
        var node = this;
        var _rawSend = node.send.bind(node);
        node.send = gate(config, _rawSend);
        node._ws        = null;
        node._pollkey   = null;
        node._signal    = null;
        node._pollTimer = null;
        node._wsTimer   = null;
        node._lastValue = null;
        node._stopped   = false;

        function stopAll(callback) {
            if (node._wsTimer) { clearTimeout(node._wsTimer); node._wsTimer = null; }
            if (node._pollTimer) { clearInterval(node._pollTimer); node._pollTimer = null; }
            var ws = node._ws;
            node._ws = null;
            if (ws) { ws.terminate(); }
            if (node._pollkey && node.robot) {
                var pk = node._pollkey;
                node._pollkey = null;
                node.robot.requestRaw('DELETE', '/subscription/' + pk, null, {})
                    .catch(function(){})
                    .then(function(){ if (callback) callback(); });
            } else { if (callback) callback(); }
        }

        function startPolling(signal) {
            if (node._stopped) return;
            node._lastValue = null;
            node.status({ fill: 'blue', shape: 'ring', text: signal + ' polling' });
            node._pollTimer = setInterval(function() {
                if (!node.robot) return;
                node.robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
                    .then(function(body) {
                        var m = body.match(/class="lvalue">([^<]+)</);
                        if (!m) return;
                        var value = parseInt(m[1].trim());
                        if (value !== node._lastValue) {
                            node._lastValue = value;
                            node.status({ fill: 'blue', shape: 'dot', text: signal + '=' + value });
                            node.send({ payload: { ok: true, signal: signal, value: value, source: 'poll' } });
                        }
                    })
                    .catch(function(err) {
                        clearInterval(node._pollTimer);
                        node._pollTimer = null;
                        node._signal = null;
                        if (/HTTP 404/.test(err.message)) {
                            node.status({ fill: 'red', shape: 'ring', text: signal + ' not found' });
                            node.error('Signal "' + signal + '" not found on controller — use IO List node to check available signal names');
                        } else {
                            node.status({ fill: 'red', shape: 'ring', text: 'poll error' });
                            node.error(err);
                        }
                    });
            }, 500);
        }

        function startSubscription(signal) {
            if (!node.robot) { node.error('No robot configured'); return; }
            var robot        = node.robot;
            var resourcePath = '/rw/iosystem/signals/' + encodeURIComponent(signal) + ';state';
            var priority     = 2;

            node._signal = signal;
            node.status({ fill: 'yellow', shape: 'ring', text: signal + ' connecting' });

            var subscribeBody = 'resources=1&1=' + encodeURIComponent(resourcePath) + '&1-p=' + priority;
            robot.requestRaw('POST', '/subscription', subscribeBody, {
                contentType: 'application/x-www-form-urlencoded;v=2.0'
            }).then(function(res) {
                if (res.statusCode !== 201) throw new Error('Subscription failed: HTTP ' + res.statusCode);
                // Use the cookie from THIS subscribe response, not a separate robot.getCookie()
                // re-fetch — the shared session cookie can be overwritten by another node's
                // concurrent request in between, causing the WS upgrade to use the wrong
                // session and fail (confirmed live: two subscribe-io nodes starting together).
                return { location: res.headers.location, cookie: res.cookie };
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
                node._wsTimer = setTimeout(function() {
                    node._wsTimer = null;
                    if (node._stopped) return;
                    var ws = new WS(sub.location, ['rws_subscription'], {
                        rejectUnauthorized: false,
                        headers: { Cookie: sub.cookie || '' }
                    });
                    node._ws = ws;
                    ws.on('open', function() {
                        node.status({ fill: 'green', shape: 'dot', text: signal + ' connected' });
                    });
                    ws.on('message', function(data) {
                        var str = data.toString();
                        var m = str.match(/class="lvalue">([^<]+)</);
                        if (m) {
                            var value = parseInt(m[1].trim());
                            node.status({ fill: 'green', shape: 'dot', text: signal + '=' + value });
                            node.send({ payload: { ok: true, signal: signal, value: value, source: 'ws' } });
                        }
                    });
                    ws.on('error', function(err) {
                        node.warn('GoFa WebSocket subscription error: ' + err.message);
                    });
                    ws.on('close', function() {
                        if (node._ws) {
                            node._ws = null;
                            if (!node._stopped) {
                                node.status({ fill: 'yellow', shape: 'ring', text: signal + ' reconnecting...' });
                                setTimeout(function() { if (!node._stopped) startSubscription(signal); }, 3000);
                            } else {
                                node.status({ fill: 'grey', shape: 'ring', text: signal + ' disconnected' });
                            }
                        }
                    });
                }, 100);
            }).catch(function(err) {
                if (/HTTP 400/.test(err.message)) {
                    startPolling(signal);
                } else {
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err);
                }
            });
        }

        function readOnce(signal) {
            node.status({ fill: 'yellow', shape: 'ring', text: signal + ' reading' });
            node.robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
                .then(function(body) {
                    var m = body.match(/class="lvalue">([^<]+)</);
                    if (m) {
                        var value = parseInt(m[1].trim());
                        node.status({ fill: node._ws ? 'green' : 'blue', shape: 'dot', text: signal + '=' + value });
                        node.send({ payload: { ok: true, signal: signal, value: value, source: node.oneshot ? 'oneshot' : (node._ws ? 'ws' : 'poll') } });
                    }
                })
                .catch(function(err) {
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err);
                });
        }

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { node.error('No robot configured'); return done(); }
            var signal = (msg.payload && typeof msg.payload === 'object' && msg.payload.signal)
                ? msg.payload.signal
                : node.signal;

            if (node.oneshot) {
                readOnce(signal);
                return done();
            }

            if ((node._ws || node._pollTimer) && node._signal === signal) {
                readOnce(signal);
                return done();
            }
            if (node._ws || node._pollTimer) {
                stopAll(function() { startSubscription(signal); });
            } else {
                startSubscription(signal);
            }
            done();
        });

        node.on('close', function(done) {
            node._stopped = true;
            stopAll(done);
        });
    }
    RED.nodes.registerType('gofa-subscribe-io', GoFaSubscribeIoNode);

    RED.httpAdmin.get('/gofa-subscribe-io/:id/signals', RED.auth.needsPermission('gofa-subscribe-io.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot.rwsGet('/rw/iosystem/signals')
        .then(function(body) {
            res.json({ ok: true, signals: parseSignalList(body) });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
