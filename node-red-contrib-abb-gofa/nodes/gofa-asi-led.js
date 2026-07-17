'use strict';
var gate = require('./lib/gate');

var PRESETS = {
    off:     { r: 0,   g: 0,   b: 0   },
    red:     { r: 255, g: 0,   b: 0   },
    green:   { r: 0,   g: 255, b: 0   },
    blue:    { r: 0,   g: 0,   b: 255 },
    yellow:  { r: 255, g: 255, b: 0   },
    cyan:    { r: 0,   g: 255, b: 255 },
    magenta: { r: 255, g: 0,   b: 255 },
    white:   { r: 255, g: 255, b: 255 },
    orange:  { r: 255, g: 128, b: 0   }
};

function clamp(v) {
    var n = Math.round(Number(v));
    return Math.max(0, Math.min(255, isNaN(n) ? 0 : n));
}

// Asi1LedRed/Green/Blue/Period are plain GO signals (SetGO in MainModule.mod) —
// in principle writable over RWS /set-value like any other signal once Access
// Level is All, same as gofa-do-write. In practice the ASI board's Access
// Level is not user-configurable on this hardware (it's the robot's built-in
// safety/collaborative status light) — the 'rws' transport is kept for any
// controller where that turns out not to be true.
//
// 'background' talks to BackgroundLed.mod instead — a second RAPID task
// (see CLAUDE.md's "Background LED task" section) that keeps serving SETLED/
// RESETLED on robot.backgroundPort even while T_ROB1 (and MainModule.mod's socket
// server) is stopped, e.g. during gofa-leadthrough hand-guiding.
function ledWrite(robot, transport, r, g, b, period) {
    if (transport === 'rws') {
        return robot.rwsPost('/rw/iosystem/signals/Asi1LedRed/set-value', 'lvalue=' + r)
            .then(function() { return robot.rwsPost('/rw/iosystem/signals/Asi1LedGreen/set-value', 'lvalue=' + g); })
            .then(function() { return robot.rwsPost('/rw/iosystem/signals/Asi1LedBlue/set-value', 'lvalue=' + b); })
            .then(function() { return robot.rwsPost('/rw/iosystem/signals/Asi1LedPeriod/set-value', 'lvalue=' + period); });
    }
    var port = transport === 'background' ? robot.backgroundPort : undefined;
    return robot.socketSend({ cmd: 'setled', val: [r, g, b, period] }, port).then(function(ack) {
        if (!ack.startsWith('OK:')) throw new Error('Unexpected reply: ' + ack);
    });
}
function ledReset(robot, transport) {
    if (transport === 'rws') return ledWrite(robot, transport, 0, 255, 0, 0);
    var port = transport === 'background' ? robot.backgroundPort : undefined;
    return robot.socketSend({ cmd: 'resetled' }, port).then(function(ack) {
        if (!ack.startsWith('OK:')) throw new Error('Unexpected reply: ' + ack);
    });
}

// Resolve msg.payload + node defaults into { r, g, b, period }.
// Returns { error: string } if the payload is invalid.
function resolvePayload(defaults, payload) {
    var r      = defaults.r;
    var g      = defaults.g;
    var b      = defaults.b;
    var period = defaults.period;

    var p = payload;
    if (p === null || p === undefined) {
        // nothing — use node defaults
    } else if (typeof p === 'string') {
        var preset = PRESETS[p.toLowerCase()];
        if (!preset) return { error: 'Unknown color: ' + p };
        r = preset.r; g = preset.g; b = preset.b;
    } else if (p === false || p === 0) {
        r = 0; g = 0; b = 0; period = 0;
    } else if (typeof p === 'number') {
        // bare non-zero number (e.g. inject timestamp) — use node defaults
    } else if (typeof p === 'object') {
        if (p.color !== undefined) {
            var cp = PRESETS[(p.color + '').toLowerCase()];
            if (!cp) return { error: 'Unknown color: ' + p.color };
            r = cp.r; g = cp.g; b = cp.b;
        }
        if (p.r !== undefined) r = p.r;
        if (p.g !== undefined) g = p.g;
        if (p.b !== undefined) b = p.b;
        if (p.period !== undefined) period = p.period;
    } else {
        return { error: 'Unsupported payload type: ' + typeof p };
    }

    return {
        r:      clamp(r),
        g:      clamp(g),
        b:      clamp(b),
        period: Math.max(0, Math.round(Number(period)))
    };
}

module.exports = function(RED) {
    function GoFaAsiLedNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.r          = parseInt(config.red)        || 0;
        this.g          = parseInt(config.grn)        || 0;
        this.b          = parseInt(config.blu)        || 0;
        this.period     = parseInt(config.period)     || 0;
        this.blinkCount = parseInt(config.blinkCount) || 0;
        this.blinkMs    = parseInt(config.blinkMs)    || 250;
        this.transport  = config.transport || 'socket';
        var node = this;

        node.on('close', function(removed, done) {
            if (typeof removed === 'function') {
                done = removed;
                removed = false;
            }
            if (node._blinkTimer) {
                clearTimeout(node._blinkTimer);
                node._blinkTimer = null;
            }
            if (node._activeBlinkDone) {
                node._activeBlinkDone();
                node._activeBlinkDone = null;
            }
            if (done) done();
        });

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            // Cancel any active blink sequence
            if (node._blinkTimer) {
                clearTimeout(node._blinkTimer);
                node._blinkTimer = null;
            }
            node._blinkSession = (node._blinkSession || 0) + 1;
            if (node._activeBlinkDone) {
                node._activeBlinkDone();
                node._activeBlinkDone = null;
            }

            var transport = (msg.payload && typeof msg.payload === 'object' && msg.payload.transport !== undefined)
                ? msg.payload.transport : node.transport;

            // 'reset' restores the LED to the normal RAPID-running state (static green)
            if (msg.payload === 'reset' || (msg.payload && msg.payload.action === 'reset')) {
                node.status({ fill: 'blue', shape: 'dot', text: 'resetting...' });
                ledReset(node.robot, transport).then(function() {
                    msg.payload = { ok: true, reset: true, transport: transport };
                    node.status({ fill: 'green', shape: 'dot', text: 'reset (green)' });
                    send(msg); done();
                }).catch(function(err) {
                    msg.payload = { ok: false, error: err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg);
                    send(msg); done(err);
                });
                return;
            }

            var result = resolvePayload(
                { r: node.r, g: node.g, b: node.b, period: node.period },
                msg.payload
            );
            if (result.error) {
                msg.payload = { ok: false, error: result.error };
                node.error(result.error, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad payload' });
                send(msg); return done();
            }

            var p = msg.payload;
            var blinkCount = (p && p.blinkCount != null) ? (Math.max(0, parseInt(p.blinkCount) || 0)) : node.blinkCount;
            var blinkMs    = (p && p.blinkMs    != null) ? (Math.max(50, parseInt(p.blinkMs)    || 250)) : node.blinkMs;

            var rv = result.r, gv = result.g, bv = result.b;

            if (blinkCount > 0 && (rv || gv || bv)) {
                // Software-controlled counted blink: N on/off cycles from Node-RED
                var remaining = blinkCount;
                node.status({ fill: 'yellow', shape: 'dot', text: 'blink 0/' + blinkCount });
                node._activeBlinkDone = done;
                var currentSession = node._blinkSession;

                function doBlink() {
                    if (node._blinkSession !== currentSession) return;
                    if (remaining <= 0) {
                        ledWrite(node.robot, transport, 0, 0, 0, 0).then(function() {
                            if (node._blinkSession !== currentSession) return;
                            node._activeBlinkDone = null;
                            msg.payload = { ok: true, r: rv, g: gv, b: bv, blinks: blinkCount, transport: transport };
                            node.status({ fill: 'grey', shape: 'dot', text: 'done ' + blinkCount + '\xd7' });
                            send(msg); done();
                        }).catch(function(err) {
                            if (node._blinkSession !== currentSession) return;
                            node._activeBlinkDone = null;
                            msg.payload = { ok: false, error: err.message };
                            node.status({ fill: 'red', shape: 'ring', text: 'error' });
                            node.error(err, msg);
                            send(msg); done(err);
                        });
                        return;
                    }
                    var current = blinkCount - remaining + 1;
                    remaining--;
                    ledWrite(node.robot, transport, rv, gv, bv, 0)
                        .then(function() {
                            if (node._blinkSession !== currentSession) return;
                            node.status({ fill: 'yellow', shape: 'dot', text: 'blink ' + current + '/' + blinkCount });
                            node._blinkTimer = setTimeout(function() {
                                node._blinkTimer = null;
                                if (node._blinkSession !== currentSession) return;
                                ledWrite(node.robot, transport, 0, 0, 0, 0)
                                    .then(function() {
                                        if (node._blinkSession !== currentSession) return;
                                        node._blinkTimer = setTimeout(function() {
                                            node._blinkTimer = null;
                                            doBlink();
                                        }, blinkMs);
                                    })
                                    .catch(function(err) {
                                        if (node._blinkSession !== currentSession) return;
                                        node._activeBlinkDone = null;
                                        msg.payload = { ok: false, error: err.message };
                                        node.status({ fill: 'red', shape: 'ring', text: 'error' });
                                        node.error(err, msg);
                                        send(msg); done(err);
                                    });
                            }, blinkMs);
                        })
                        .catch(function(err) {
                            if (node._blinkSession !== currentSession) return;
                            node._activeBlinkDone = null;
                            msg.payload = { ok: false, error: err.message };
                            node.status({ fill: 'red', shape: 'ring', text: 'error' });
                            node.error(err, msg);
                            send(msg); done(err);
                        });
                }
                doBlink();
                return;
            }

            // Single SETLED command — hardware period signal controls continuous blink
            var period = result.period;
            var label = 'R' + rv + ' G' + gv + ' B' + bv + (period ? ' ~' + period : '');
            node.status({ fill: 'blue', shape: 'dot', text: label });

            ledWrite(node.robot, transport, rv, gv, bv, period).then(function() {
                msg.payload = { ok: true, r: rv, g: gv, b: bv, period: period, transport: transport };
                node.status({ fill: (rv || gv || bv) ? 'green' : 'grey', shape: 'dot', text: label });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }

    RED.nodes.registerType('gofa-asi-led', GoFaAsiLedNode);

    RED.httpAdmin.post('/gofa-asi-led/:id/set', RED.auth.needsPermission('gofa-asi-led.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var payload = req.body.payload;
        var transport = req.body.transport || 'socket';

        if (payload === 'reset' || (payload && payload.action === 'reset')) {
            ledReset(robot, transport).then(function() {
                res.json({ ok: true, reset: true });
            }).catch(function(err) {
                res.status(502).json({ error: err.message });
            });
            return;
        }

        var defaults = {
            r: parseInt(req.body.red) || 0,
            g: parseInt(req.body.green) || 0,
            b: parseInt(req.body.blue) || 0,
            period: parseInt(req.body.period) || 0
        };

        var result = resolvePayload(defaults, payload);
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }

        var rv = result.r, gv = result.g, bv = result.b;
        var blinkCount = Math.max(0, parseInt(req.body.blinkCount) || 0);
        var blinkMs    = Math.max(50, parseInt(req.body.blinkMs) || 250);

        if (blinkCount > 0 && (rv || gv || bv)) {
            // Software counted blink, same behavior as the runtime node; a newer
            // panel click supersedes an in-flight one via the session counter.
            var session = robot._ledPanelBlink = (robot._ledPanelBlink || 0) + 1;
            var remaining = blinkCount;
            var wait = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
            var blinkOnce = function() {
                if (robot._ledPanelBlink !== session) return Promise.resolve();
                if (remaining <= 0) return ledWrite(robot, transport, 0, 0, 0, 0);
                remaining--;
                return ledWrite(robot, transport, rv, gv, bv, 0)
                    .then(function() { return wait(blinkMs); })
                    .then(function() { return ledWrite(robot, transport, 0, 0, 0, 0); })
                    .then(function() { return wait(blinkMs); })
                    .then(blinkOnce);
            };
            blinkOnce().then(function() {
                res.json({ ok: true, r: rv, g: gv, b: bv, blinks: blinkCount });
            }).catch(function(err) {
                res.status(502).json({ error: err.message });
            });
            return;
        }

        ledWrite(robot, transport, rv, gv, bv, result.period)
        .then(function() {
            res.json({ ok: true, r: rv, g: gv, b: bv, period: result.period });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};

module.exports.PRESETS        = PRESETS;
module.exports.clamp          = clamp;
module.exports.resolvePayload = resolvePayload;
