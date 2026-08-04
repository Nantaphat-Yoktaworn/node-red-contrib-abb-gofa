'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
var jog = require('./lib/jog');
module.exports = function(RED) {
    function GoFaJogNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        // `axis` is the pre-2.6.0 gofa-jog field name; reading it here keeps
        // already-deployed Jog nodes working without an edit-and-redeploy.
        this.target = config.target || config.axis || 'X';
        this.dir    = config.dir    || '+';
        this.step   = parseFloat(config.step) || 10;
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var p      = msg.payload || {};
            var target = jog.pickTarget(p, node.target);
            var dir    = p.dir  !== undefined ? p.dir  : node.dir;
            var step   = p.step !== undefined ? p.step : node.step;

            var r = jog(target, dir, step);
            if (r.error) {
                msg.payload = { ok: false, error: r.error };
                node.error(r.error, msg);
                node.status({ fill: 'red', shape: 'ring', text: r.status });
                send(msg); return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: r.token });
            node.robot.socketSend(r.cmd).then(function(ack) {
                var ok = ack.startsWith('OK:');
                msg.payload = { ok: ok, ack: ack, token: r.token };
                node.status({ fill: ok ? 'green' : 'red', shape: 'dot', text: ack });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-jog', GoFaJogNode);

    RED.httpAdmin.post('/gofa-jog/:id/jog', requireAdminAuth(RED, 'gofa-jog.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var body = req.body || {};
        var r = jog(jog.pickTarget(body, 'X'), body.dir || '+', body.step !== undefined ? body.step : 10);
        if (r.error) return res.status(400).json({ error: r.error });

        robot.socketSend(r.cmd).then(function(ack) {
            if (!ack.startsWith('OK:')) {
                throw new Error(ack);
            }
            res.json({ ok: true, ack: ack, token: r.token });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
