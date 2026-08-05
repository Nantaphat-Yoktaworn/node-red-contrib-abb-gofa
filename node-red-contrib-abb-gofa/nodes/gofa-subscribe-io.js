'use strict';
var gate = require('./lib/gate');
var fetchSignals = require('./lib/list-signals').fetchSignals;
var createSubscription = require('./lib/rws-subscription');

function parseLvalue(body) {
    var m = String(body).match(/class="lvalue">([^<]+)</);
    return m ? parseInt(m[1].trim()) : null;
}

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

        var current = null;   // the createSubscription handle for node._signal

        // Fallback for controllers that reject a subscription on this resource
        // (HTTP 400): poll the signal and emit only on change.
        function startPolling(signal) {
            if (node._stopped) return;
            node._lastValue = null;
            node.status({ fill: 'blue', shape: 'ring', text: signal + ' polling' });
            node._pollTimer = setInterval(function() {
                if (!node.robot) return;
                node.robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
                    .then(function(body) {
                        var value = parseLvalue(body);
                        if (value === null) return;
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

        // C3: subscribe/WS/reconnect mechanics live in lib/rws-subscription.js.
        function subscribeTo(signal) {
            node._signal = signal;
            current = createSubscription(node, {
                label: signal,
                resourcePath: '/rw/iosystem/signals/' + encodeURIComponent(signal) + ';state',
                priority: 2,
                onStatus: function(s) { node.status(s); },
                onMessage: function(data) {
                    var value = parseLvalue(data.toString());
                    if (value === null) return;
                    node.status({ fill: 'green', shape: 'dot', text: signal + '=' + value });
                    node.send({ payload: { ok: true, signal: signal, value: value, source: 'ws' } });
                },
                onError: function(err) {
                    // A 400 here means this controller won't subscribe to the resource —
                    // degrade to polling rather than failing the node outright.
                    if (/HTTP 400/.test(err.message)) { startPolling(signal); return true; }
                    return false;
                }
            });
            current.start();
        }

        function readOnce(signal) {
            node.status({ fill: 'yellow', shape: 'ring', text: signal + ' reading' });
            node.robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
                .then(function(body) {
                    var value = parseLvalue(body);
                    if (value === null) return;
                    node.status({ fill: node._ws ? 'green' : 'blue', shape: 'dot', text: signal + '=' + value });
                    node.send({ payload: { ok: true, signal: signal, value: value,
                        source: node.oneshot ? 'oneshot' : (node._ws ? 'ws' : 'poll') } });
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

            if (node.oneshot) { readOnce(signal); return done(); }

            // Already watching this exact signal — just report its current value.
            if ((node._ws || node._pollTimer) && node._signal === signal) {
                readOnce(signal);
                return done();
            }
            // Watching a different signal — tear that down first so its
            // subscription is released before the new one is created.
            if (node._ws || node._pollTimer) {
                var prev = current;
                if (prev) prev.stop(function() { subscribeTo(signal); });
                else subscribeTo(signal);
            } else {
                subscribeTo(signal);
            }
            done();
        });

        node.on('close', function(done) {
            node._stopped = true;
            if (current) current.stop(done);
            else done();
        });
    }
    RED.nodes.registerType('gofa-subscribe-io', GoFaSubscribeIoNode);

    RED.httpAdmin.get('/gofa-subscribe-io/:id/signals', RED.auth.needsPermission('gofa-subscribe-io.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        fetchSignals(robot)
        .then(function(signals) {
            res.json({ ok: true, signals: signals });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
