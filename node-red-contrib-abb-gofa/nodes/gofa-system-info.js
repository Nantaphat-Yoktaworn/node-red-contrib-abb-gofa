'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaSystemInfoNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var r = node.robot;
            node.status({ fill: 'blue', shape: 'dot', text: 'reading...' });
            Promise.all([
                r.rwsGet('/rw/system'),
                r.rwsGet('/ctrl/identity')
            ]).then(function(b) {
                var sys  = b[0];
                var ctrl = b[1];
                var p = function(body, cls) { return r.parseXhtml(body, cls); };
                var out = { ok: true };
                var rwv  = p(sys,  'rwversion');    if (rwv)  out.rwVersion   = rwv;
                var rwd  = p(sys,  'rwbuilddate');  if (rwd)  out.rwBuildDate = rwd;
                var cns  = p(sys,  'ctrl-name');    if (cns)  out.ctrlName    = cns;
                var cni  = p(ctrl, 'ctrl-name');    if (cni && !out.ctrlName) out.ctrlName = cni;
                var cid  = p(ctrl, 'ctrl-id');      if (cid)  out.ctrlId      = cid;
                var ctp  = p(ctrl, 'ctrl-type');    if (ctp)  out.ctrlType    = ctp;
                var cmc  = p(ctrl, 'ctrl-mac');     if (cmc)  out.ctrlMac     = cmc;
                msg.payload = out;
                node.status({ fill: 'green', shape: 'dot', text: out.ctrlName || 'ok' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-system-info', GoFaSystemInfoNode);

    RED.httpAdmin.get('/gofa-system-info/:id/read', RED.auth.needsPermission('gofa-system-info.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        Promise.all([
            robot.rwsGet('/rw/system'),
            robot.rwsGet('/ctrl/identity')
        ]).then(function(b) {
            var sys  = b[0];
            var ctrl = b[1];
            var p = function(body, cls) { return robot.parseXhtml(body, cls); };
            var out = { ok: true };
            var rwv  = p(sys,  'rwversion');    if (rwv)  out.rwVersion   = rwv;
            var rwd  = p(sys,  'rwbuilddate');  if (rwd)  out.rwBuildDate = rwd;
            var cns  = p(sys,  'ctrl-name');    if (cns)  out.ctrlName    = cns;
            var cni  = p(ctrl, 'ctrl-name');    if (cni && !out.ctrlName) out.ctrlName = cni;
            var cid  = p(ctrl, 'ctrl-id');      if (cid)  out.ctrlId      = cid;
            var ctp  = p(ctrl, 'ctrl-type');    if (ctp)  out.ctrlType    = ctp;
            var cmc  = p(ctrl, 'ctrl-mac');     if (cmc)  out.ctrlMac     = cmc;
            res.json(out);
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
