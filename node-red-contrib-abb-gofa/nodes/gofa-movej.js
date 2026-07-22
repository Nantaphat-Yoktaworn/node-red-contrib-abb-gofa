'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
var gofaRobot = require('./gofa-robot');
var resolveMoveType = gofaRobot.resolveMoveType;
var validateJoints = gofaRobot.validateJoints;
module.exports = function(RED) {
    function GoFaMoveJNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.joints   = config.joints || '[0,0,85,0,0,0]';
        this.moveType = resolveMoveType(config.moveType, 'J');
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var j;
            if (msg.payload !== null && msg.payload !== undefined) {
                if (Array.isArray(msg.payload) && msg.payload.length === 6) {
                    j = msg.payload;
                } else if (typeof msg.payload === 'object' && !Array.isArray(msg.payload)) {
                    var p = msg.payload;
                    if (p.j1 !== undefined) {
                        j = [p.j1, p.j2, p.j3, p.j4, p.j5, p.j6];
                    } else {
                        j = null;
                    }
                } else {
                    j = null;
                }
            } else {
                j = null;
            }

            if (!j) {
                try {
                    j = JSON.parse(node.joints);
                } catch(e) {
                    msg.payload = { ok: false, error: 'Invalid joints config: ' + node.joints };
                    node.error('Invalid joints config: ' + node.joints, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                    send(msg); return done();
                }
            }

            if (!Array.isArray(j) || j.length !== 6) {
                msg.payload = { ok: false, error: 'joints must be a 6-element array' };
                node.error('joints must be a 6-element array', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                send(msg); return done();
            }

            var nums = j.map(function(v) { return parseFloat(v); });
            if (nums.some(function(v) { return isNaN(v); })) {
                msg.payload = { ok: false, error: 'joints contains non-numeric values' };
                node.error('joints contains non-numeric values', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                send(msg); return done();
            }

            // Soft joint-limit check (fail fast with a clean error instead of a
            // RAPID motion fault). Limits come from the robot config node
            // (CRB 15000-12 hardware defaults unless overridden).
            var jchk = validateJoints(nums, node.robot.jointLimits);
            if (!jchk.ok) {
                var jerr = 'Joint ' + jchk.joint + ' = ' + jchk.value + '° is outside its limit [' + jchk.min + ', ' + jchk.max + ']';
                msg.payload = { ok: false, error: jerr, joint: jchk.joint, value: jchk.value, min: jchk.min, max: jchk.max };
                node.error(jerr, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'joint ' + jchk.joint + ' out of range' });
                send(msg); return done();
            }

            // Move type: J = MoveAbsJ (joint-interpolated, default, most reliable),
            // L = straight-line TCP path to the pose those joints describe (the
            // RAPID server does the forward kinematics via CalcRobT). Same
            // per-message override names gofa-go-point uses.
            var moveType = node.moveType;
            if (msg.moveType !== undefined) moveType = resolveMoveType(msg.moveType, moveType);
            if (msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) && msg.payload.moveType !== undefined) {
                moveType = resolveMoveType(msg.payload.moveType, moveType);
            }
            var cmdName = moveType === 'L' ? 'movel' : 'movej';

            node.status({ fill: 'blue', shape: 'dot', text: cmdName + ': [' + nums.map(function(v) { return v.toFixed(1); }).join(',') + ']' });

            node.robot.socketSend({ cmd: cmdName, val: nums.map(function(v) { return parseFloat(v.toFixed(2)); }) }).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, joints: nums, moveType: moveType };
                node.status({ fill: 'green', shape: 'dot', text: '[' + nums.map(function(v) { return v.toFixed(1); }).join(',') + ']' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-movej', GoFaMoveJNode);

    RED.httpAdmin.post('/gofa-movej/:id/move', requireAdminAuth(RED, 'gofa-movej.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var j = req.body.joints;
        var moveType = req.body.moveType || 'J';

        if (typeof j === 'string') {
            try {
                j = JSON.parse(j);
            } catch(e) {
                return res.status(400).json({ error: 'Invalid joints string: ' + j });
            }
        }

        if (!Array.isArray(j) || j.length !== 6) {
            return res.status(400).json({ error: 'joints must be a 6-element array' });
        }

        var nums = j.map(function(v) { return parseFloat(v); });
        if (nums.some(function(v) { return isNaN(v); })) {
            return res.status(400).json({ error: 'joints contains non-numeric values' });
        }

        var jchk = validateJoints(nums, robot.jointLimits);
        if (!jchk.ok) {
            return res.status(400).json({ error: 'Joint ' + jchk.joint + ' = ' + jchk.value +
                '° is outside its limit [' + jchk.min + ', ' + jchk.max + ']',
                joint: jchk.joint, value: jchk.value, min: jchk.min, max: jchk.max });
        }

        var cmdName = moveType === 'L' ? 'movel' : 'movej';

        robot.socketSend({ cmd: cmdName, val: nums.map(function(v) { return parseFloat(v.toFixed(2)); }) }).then(function(resp) {
            if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
            res.json({ ok: true, joints: nums, moveType: moveType });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
