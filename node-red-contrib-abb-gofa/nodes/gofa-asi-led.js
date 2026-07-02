'use strict';

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
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            // 'reset' restores the LED to the normal RAPID-running state (static green)
            if (msg.payload === 'reset' || (msg.payload && msg.payload.action === 'reset')) {
                node.status({ fill: 'blue', shape: 'dot', text: 'resetting...' });
                node.robot.socketSend('RESETLED').then(function(ack) {
                    if (!ack.startsWith('OK:')) throw new Error('Unexpected reply: ' + ack);
                    msg.payload = { ok: true, reset: true };
                    node.status({ fill: 'green', shape: 'dot', text: 'reset (green)' });
                    send(msg); done();
                }).catch(function(err) {
                    msg.payload = { ok: false, error: err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg); done(err);
                });
                return;
            }

            var result = resolvePayload(
                { r: node.r, g: node.g, b: node.b, period: node.period },
                msg.payload
            );
            if (result.error) {
                node.error(result.error, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad payload' });
                return done();
            }

            var p = msg.payload;
            var blinkCount = (p && p.blinkCount != null) ? (Math.max(0, parseInt(p.blinkCount) || 0)) : node.blinkCount;
            var blinkMs    = (p && p.blinkMs    != null) ? (Math.max(50, parseInt(p.blinkMs)    || 250)) : node.blinkMs;

            var rv = result.r, gv = result.g, bv = result.b;

            if (blinkCount > 0 && (rv || gv || bv)) {
                // Software-controlled counted blink: N on/off cycles from Node-RED
                var remaining = blinkCount;
                node.status({ fill: 'yellow', shape: 'dot', text: 'blink 0/' + blinkCount });

                function doBlink() {
                    if (remaining <= 0) {
                        node.robot.socketSend('SETLED:0;0;0;0').then(function() {
                            msg.payload = { ok: true, r: rv, g: gv, b: bv, blinks: blinkCount };
                            node.status({ fill: 'grey', shape: 'dot', text: 'done ' + blinkCount + '\xd7' });
                            send(msg); done();
                        }).catch(function(err) {
                            node.status({ fill: 'red', shape: 'ring', text: 'error' });
                            node.error(err, msg); done(err);
                        });
                        return;
                    }
                    var current = blinkCount - remaining + 1;
                    remaining--;
                    node.robot.socketSend('SETLED:' + rv + ';' + gv + ';' + bv + ';0')
                        .then(function() {
                            node.status({ fill: 'yellow', shape: 'dot', text: 'blink ' + current + '/' + blinkCount });
                            setTimeout(function() {
                                node.robot.socketSend('SETLED:0;0;0;0')
                                    .then(function() { setTimeout(doBlink, blinkMs); })
                                    .catch(function(err) { node.status({ fill: 'red', shape: 'ring', text: 'error' }); node.error(err, msg); done(err); });
                            }, blinkMs);
                        })
                        .catch(function(err) { node.status({ fill: 'red', shape: 'ring', text: 'error' }); node.error(err, msg); done(err); });
                }
                doBlink();
                return;
            }

            // Single SETLED command — hardware period signal controls continuous blink
            var period = result.period;
            var label = 'R' + rv + ' G' + gv + ' B' + bv + (period ? ' ~' + period : '');
            node.status({ fill: 'blue', shape: 'dot', text: label });

            var token = 'SETLED:' + rv + ';' + gv + ';' + bv + ';' + period;
            node.robot.socketSend(token).then(function(ack) {
                if (!ack.startsWith('OK:')) throw new Error('Unexpected reply: ' + ack);
                msg.payload = { ok: true, r: rv, g: gv, b: bv, period: period };
                node.status({ fill: (rv || gv || bv) ? 'green' : 'grey', shape: 'dot', text: label });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }

    RED.nodes.registerType('gofa-asi-led', GoFaAsiLedNode);
};

module.exports.PRESETS        = PRESETS;
module.exports.clamp          = clamp;
module.exports.resolvePayload = resolvePayload;
