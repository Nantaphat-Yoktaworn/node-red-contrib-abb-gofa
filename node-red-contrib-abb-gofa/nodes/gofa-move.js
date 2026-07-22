'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaMoveNode(config) {
        RED.nodes.createNode(this, config);
        this.robot   = RED.nodes.getNode(config.robot);
        this.command = config.command || 'HOME';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var raw = msg.payload;
            var cmd = (typeof raw === 'string' && raw) ? raw
                    : (raw && raw.command)             ? raw.command
                    : node.command;
            var upperCmd = String(cmd).toUpperCase();
            if (upperCmd !== 'HOME' && upperCmd !== 'SETHOME') {
                msg.payload = { ok: false, error: 'Invalid command: ' + cmd };
                node.error('Invalid command: ' + cmd, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad command' });
                send(msg); return done();
            }
            node.status({ fill:'blue', shape:'dot', text: cmd });
            node.robot.socketSend({ cmd: cmd.toLowerCase() }).then(function(ack) {
                var ok = ack.startsWith('OK:');
                msg.payload = { ok: ok, ack: ack };
                node.status({ fill: ok?'green':'red', shape:'dot', text: ack });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill:'red', shape:'ring', text:'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-move', GoFaMoveNode);

    RED.httpAdmin.post('/gofa-move/:id/action', requireAdminAuth(RED, 'gofa-move.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var cmd = req.body.command || 'HOME';
        var upperCmd = String(cmd).toUpperCase();
        if (upperCmd !== 'HOME' && upperCmd !== 'SETHOME') {
            return res.status(400).json({ error: 'Invalid command: ' + cmd });
        }

        robot.socketSend({ cmd: cmd.toLowerCase() }).then(function(ack) {
            var ok = ack.startsWith('OK:');
            if (!ok) {
                throw new Error(ack);
            }
            res.json({ ok: true, ack: ack });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
