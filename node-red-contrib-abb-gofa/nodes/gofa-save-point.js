'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaSavePointNode(config) {
        RED.nodes.createNode(this, config);
        this.robot     = RED.nodes.getNode(config.robot);
        this.pointName = config.pointName || '';
        this.storage   = config.storage   || 'local';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var name = '';
            if (msg.payload) {
                if (typeof msg.payload === 'string') {
                    name = msg.payload;
                } else if (typeof msg.payload === 'object') {
                    name = msg.payload.name || '';
                }
            }
            if (!name) {
                name = node.pointName || '';
            }
            // A blank name is intentional, not an error — resolvePointName() in
            // gofa-robot.js (used by both addPoint/remoteAddPoint below) already
            // auto-generates "Point N" for an empty name. Rejecting it here would
            // break that documented auto-numbering workflow.
            name = String(name).trim();
            var storage = (msg.payload && typeof msg.payload === 'object' && msg.payload.storage) || node.storage;
            var r = node.robot;
            node.status({ fill: 'blue', shape: 'dot', text: 'reading pose...' });
            r.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
            .then(function(body) {
                var p = function(c){ return parseFloat(r.parseXhtml(body, c)); };
                var target = {
                    x: p('x'), y: p('y'), z: p('z'),
                    q1: p('q1'), q2: p('q2'), q3: p('q3'), q4: p('q4'),
                    cf1: p('cf1'), cf4: p('cf4'), cf6: p('cf6'), cfx: p('cfx')
                };
                if (storage === 'remote') {
                    return r.remoteAddPoint(name, target).then(function(pt) {
                        if (pt.error) return pt;
                        return r.remoteGetPoints().then(function(points) { return { point: pt, points: points }; });
                    });
                }
                var pt = r.addPoint(name, target);
                if (pt.error) return pt;
                return { point: pt, points: r.getPoints() };
            })
            .then(function(result) {
                if (result.error) {
                    msg.payload = { ok: false, error: result.error };
                    node.status({ fill: 'red', shape: 'ring', text: result.error });
                    return send(msg), done();
                }
                msg.payload = { ok: true, point: result.point, points: result.points };
                node.status({ fill: 'green', shape: 'dot', text: 'saved: ' + result.point.name });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-save-point', GoFaSavePointNode);

    RED.httpAdmin.post('/gofa-save-point/:id/save', RED.auth.needsPermission('gofa-save-point.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var name = String(req.body.pointName || '').trim();
        var storage = req.body.storage || 'local';

        robot.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
        .then(function(body) {
            var p = function(c){ return parseFloat(robot.parseXhtml(body, c)); };
            var target = {
                x: p('x'), y: p('y'), z: p('z'),
                q1: p('q1'), q2: p('q2'), q3: p('q3'), q4: p('q4'),
                cf1: p('cf1'), cf4: p('cf4'), cf6: p('cf6'), cfx: p('cfx')
            };
            if (storage === 'remote') {
                if (typeof robot.remoteAddPoint !== 'function' || typeof robot.remoteGetPoints !== 'function') {
                    throw new Error('Remote storage not supported/configured');
                }
                return robot.remoteAddPoint(name, target).then(function(pt) {
                    if (pt.error) return pt;
                    return robot.remoteGetPoints().then(function(points) { return { point: pt, points: points }; });
                });
            }
            if (typeof robot.addPoint !== 'function' || typeof robot.getPoints !== 'function') {
                throw new Error('Local storage not supported/configured');
            }
            var pt = robot.addPoint(name, target);
            if (pt.error) return pt;
            return { point: pt, points: robot.getPoints() };
        })
        .then(function(result) {
            if (result.error) {
                return res.status(400).json({ error: result.error });
            }
            res.json({ ok: true, point: result.point, points: result.points });
        })
        .catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
