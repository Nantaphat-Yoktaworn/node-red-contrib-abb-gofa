'use strict';
var dgram = require('dgram');

// Reserved DO signal: gofa-egm's "please stop gracefully" trigger, watched
// by an ISignalDO interrupt in MainModuleEGM.mod's RunEgmJoint. Already has
// Access:All on this controller (confirmed live) so no RobotStudio change
// is needed to write it over RWS. If this signal is ever needed elsewhere,
// move it in both places (here and MainModuleEGM.mod).
var STOP_SIGNAL = 'ABB_Scalable_IO_0_DO16';

// ── EGM protobuf codec (hand-rolled, proto2 wire format) ────────────────────
// Covers only the fields this node actually reads/writes — see
// gofa-egm-python/proto/egm.proto (ABB's own wire schema) for the full
// message set this is a subset of. Field numbers below are taken straight
// from that .proto file. No protobufjs dependency: this package's only
// runtime dependency is 'ws', for the RWS subscribe nodes.

var MSGTYPE_CORRECTION = 3; // EgmHeader.MessageType.MSGTYPE_CORRECTION

// Varints use addition-by-power-of-two instead of bit-shifts so values up to
// Number.MAX_SAFE_INTEGER decode correctly — plain `<<`/`|` truncate to 32
// bits in JS, which would misparse a uint32 seqno/tm above 2^31.
function readVarint(buf, offset) {
    var result = 0, shift = 0, b;
    do {
        if (offset >= buf.length) throw new Error('truncated varint');
        b = buf[offset++];
        result += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (b & 0x80);
    return { value: result, offset: offset };
}

function writeVarint(value) {
    var bytes = [];
    value = Math.floor(value);
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value = Math.floor(value / 128);
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
}

function writeTag(fieldNumber, wireType) { return writeVarint((fieldNumber << 3) | wireType); }

function writeLengthDelimited(fieldNumber, contentBuf) {
    return Buffer.concat([writeTag(fieldNumber, 2), writeVarint(contentBuf.length), contentBuf]);
}

function writeVarintField(fieldNumber, value) {
    return Buffer.concat([writeTag(fieldNumber, 0), writeVarint(value)]);
}

function writeDoubleField(fieldNumber, value) {
    var v = Buffer.alloc(8);
    v.writeDoubleLE(value, 0);
    return Buffer.concat([writeTag(fieldNumber, 1), v]);
}

// Parses one proto2 message level into { fieldNumber: [{wireType, raw}, ...] }
// without interpreting anything — callers pick the fields they need. Proto2
// "optional" semantics: the LAST occurrence of a scalar field wins.
function decodeFields(buf) {
    var fields = {};
    var offset = 0;
    while (offset < buf.length) {
        var tag = readVarint(buf, offset);
        offset = tag.offset;
        var fieldNumber = tag.value >>> 3;
        var wireType = tag.value & 0x7;
        var entry;
        if (wireType === 0) {
            var v = readVarint(buf, offset);
            entry = { wireType: 0, raw: v.value };
            offset = v.offset;
        } else if (wireType === 1) {
            entry = { wireType: 1, raw: buf.slice(offset, offset + 8) };
            offset += 8;
        } else if (wireType === 2) {
            var len = readVarint(buf, offset);
            offset = len.offset;
            entry = { wireType: 2, raw: buf.slice(offset, offset + len.value) };
            offset += len.value;
        } else if (wireType === 5) {
            entry = { wireType: 5, raw: buf.slice(offset, offset + 4) };
            offset += 4;
        } else {
            throw new Error('EGM codec: unsupported wire type ' + wireType);
        }
        (fields[fieldNumber] = fields[fieldNumber] || []).push(entry);
    }
    return fields;
}

function lastField(fields, num) {
    var arr = fields[num];
    return (arr && arr.length) ? arr[arr.length - 1] : null;
}

// "repeated double" — proto2 default is unpacked (one fixed64 entry per
// value), but a decoder must also accept a packed (length-delimited)
// encoding regardless of what the .proto declares, since that's a valid
// wire-compatible alternative any encoder could choose.
function decodeDoubleArray(fields, num) {
    var arr = fields[num];
    if (!arr) return [];
    var out = [];
    arr.forEach(function(entry) {
        if (entry.wireType === 1) {
            out.push(entry.raw.readDoubleLE(0));
        } else if (entry.wireType === 2) {
            for (var i = 0; i + 8 <= entry.raw.length; i += 8) {
                out.push(entry.raw.readDoubleLE(i));
            }
        }
    });
    return out;
}

// EgmRobot (controller -> sensor). Only the fields gofa-egm reads:
// header{seqno=1, tm=2}, feedBack=2{joints=1}, planned=3{joints=1},
// motorState=4{state=1}, mciState=5{state=1}, mciConvergenceMet=6.
function decodeEgmRobot(buf) {
    var top = decodeFields(buf);
    var out = {
        seqno: 0, tm: 0, feedbackJoints: [], plannedJoints: [],
        mciState: 0, motorsOn: null, convergence: null
    };

    var header = lastField(top, 1);
    if (header && header.wireType === 2) {
        var h = decodeFields(header.raw);
        var seqno = lastField(h, 1); if (seqno) out.seqno = seqno.raw;
        var tm    = lastField(h, 2); if (tm)    out.tm    = tm.raw;
    }

    var feedBack = lastField(top, 2);
    if (feedBack && feedBack.wireType === 2) {
        var fb = decodeFields(feedBack.raw);
        var joints = lastField(fb, 1);
        if (joints && joints.wireType === 2) out.feedbackJoints = decodeDoubleArray(decodeFields(joints.raw), 1);
    }

    var planned = lastField(top, 3);
    if (planned && planned.wireType === 2) {
        var pl = decodeFields(planned.raw);
        var pJoints = lastField(pl, 1);
        if (pJoints && pJoints.wireType === 2) out.plannedJoints = decodeDoubleArray(decodeFields(pJoints.raw), 1);
    }

    var motorState = lastField(top, 4);
    if (motorState && motorState.wireType === 2) {
        var ms = decodeFields(motorState.raw);
        var state = lastField(ms, 1);
        if (state) out.motorsOn = state.raw === 1; // MOTORS_ON = 1
    }

    var mciState = lastField(top, 5);
    if (mciState && mciState.wireType === 2) {
        var mci = decodeFields(mciState.raw);
        var state2 = lastField(mci, 1);
        if (state2) out.mciState = state2.raw;
    }

    var convergence = lastField(top, 6);
    if (convergence) out.convergence = !!convergence.raw;

    return out;
}

// EgmSensor (sensor -> controller): header{seqno=1, mtype=3=CORRECTION},
// planned=2{joints=1{joints: repeated double=1}}.
function encodeEgmSensor(seqno, joints) {
    if (!Array.isArray(joints) || joints.length !== 6 ||
        joints.some(function(j) { return typeof j !== 'number' || !isFinite(j); })) {
        throw new Error('encodeEgmSensor: joints must be an array of 6 finite numbers');
    }
    var header = Buffer.concat([
        writeVarintField(1, seqno >>> 0),
        writeVarintField(3, MSGTYPE_CORRECTION)
    ]);
    var jointsMsg  = Buffer.concat(joints.map(function(j) { return writeDoubleField(1, j); }));
    var plannedMsg = writeLengthDelimited(1, jointsMsg);
    return Buffer.concat([
        writeLengthDelimited(1, header),
        writeLengthDelimited(2, plannedMsg)
    ]);
}

module.exports = function(RED) {
    function GoFaEgmNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.udpPort    = parseInt(config.udpPort) || 6510;
        this.throttleMs = parseInt(config.throttleMs) || 100;
        var node = this;

        node._socket    = null;
        node._streaming = false;
        node._starting  = false;
        node._stopped   = false;
        node._baseline  = null;
        node._target    = null;
        node._lastEmit  = 0;

        function stopAll() {
            node._streaming = false;
            node._baseline  = null;
            node._target    = null;
            if (node._socket) {
                try { node._socket.close(); } catch (e) { /* already closing */ }
                node._socket = null;
            }
        }

        function onFrame(buf, rinfo) {
            var robot;
            try { robot = decodeEgmRobot(buf); }
            catch (e) { node.error('EGM decode error: ' + e.message); return; }
            if (robot.feedbackJoints.length !== 6) return;

            // First frame of the session: hold the current pose until a flow
            // sets an explicit target (nudge_joint.py's "baseline" behavior —
            // never move on connect).
            if (!node._baseline) {
                node._baseline = robot.feedbackJoints;
                node._target   = node._baseline;
            }

            node._socket.send(encodeEgmSensor(robot.seqno, node._target), rinfo.port, rinfo.address);

            var now = Date.now();
            if (now - node._lastEmit >= node.throttleMs) {
                node._lastEmit = now;
                node.send({ payload: {
                    ok: true, joints: robot.feedbackJoints, seqno: robot.seqno,
                    mciState: robot.mciState, motorsOn: robot.motorsOn,
                    convergence: robot.convergence, source: 'egm'
                }});
            }
        }

        // Binds the UDP socket and resolves once the first EGM frame arrives
        // (proof the controller is actually in EGM mode and talking to us).
        // No frame within 2s -> reject, most likely UDPUC config or firewall.
        function bindSocket() {
            return new Promise(function(resolve, reject) {
                var sock = dgram.createSocket('udp4');
                var settled = false;
                node._socket = sock;

                var noFrameTimer = setTimeout(function() {
                    if (settled) return;
                    settled = true;
                    stopAll();
                    reject(new Error('No EGM frames received within 2s on UDP :' + node.udpPort +
                        ' — check the UDPUC "EGM_PC" transmission protocol config and firewall'));
                }, 2000);

                sock.on('error', function(err) {
                    clearTimeout(noFrameTimer);
                    if (!settled) { settled = true; stopAll(); reject(err); }
                    else {
                        node.status({ fill: 'red', shape: 'ring', text: 'socket error' });
                        node.error('EGM socket error: ' + err.message);
                        stopAll();
                    }
                });

                sock.on('message', function(buf, rinfo) {
                    if (!settled) {
                        settled = true;
                        clearTimeout(noFrameTimer);
                        node._streaming = true;
                        node.status({ fill: 'green', shape: 'dot', text: 'streaming (holding)' });
                        resolve();
                    }
                    onFrame(buf, rinfo);
                });

                sock.bind(node.udpPort);
            });
        }

        function start() {
            if (!node.robot) return Promise.reject(new Error('No robot configured'));
            if (node._streaming || node._starting) return Promise.resolve();
            node._starting = true;
            node.status({ fill: 'blue', shape: 'dot', text: 'switching to EGM...' });

            return node.robot.socketSend('EGMJOINT').then(function(reply) {
                if (reply === 'ERR:EGMJOINT') {
                    var err = new Error('Controller is running MainModule.mod (no EGM support) — ' +
                        'load MainModuleEGM.mod via gofa-upload-mod + gofa-rapid-exec ' +
                        '(loadmod, resetpp, start) first');
                    err.wrongModule = true;
                    throw err;
                }
                if (!reply.startsWith('OK:EGMJOINT')) throw new Error('Unexpected reply to EGMJOINT: ' + reply);
                node.status({ fill: 'yellow', shape: 'ring', text: 'waiting for EGM frames...' });
                return bindSocket();
            }).finally(function() { node._starting = false; });
        }

        // Polls PING until the TCP socket server responds again -- the only
        // way to confirm RunEgmJoint actually returned and main() rebuilt
        // ServeForever, since setting the stop signal alone doesn't prove
        // the TRAP fired. Most attempts before the server is back fail fast
        // (connection refused, not a hang), so a short poll interval is fine.
        function waitForTcpBack(timeoutMs) {
            var deadline = Date.now() + timeoutMs;
            function attempt() {
                return node.robot.socketSend('PING').then(function(reply) {
                    if (reply !== 'OK:PING') throw new Error('unexpected reply: ' + reply);
                }).catch(function(err) {
                    if (Date.now() >= deadline) throw err;
                    return new Promise(function(res) { setTimeout(res, 300); }).then(attempt);
                });
            }
            return attempt();
        }

        // FIXED (2026-07-09), per ABB's EGM Application Manual (3HAC073318):
        // an external RWS task-level stop (the original design here) skips
        // RunEgmJoint's own cleanup entirely, leaking one controller-side
        // EGM instance every cycle -- RobotWare allows max 4 concurrent EGM
        // identities, so repeated start/stop cycling reliably exhausted the
        // pool ("Too many EGM instances"), confirmed live. The manual
        // documents EGMStop specifically for use in a RAPID TRAP to end a
        // running EGMRunJoint/EGMRunPose *gracefully* -- the task never
        // actually stops, so its own cleanup (EGMReset) always runs.
        // MainModuleEGM.mod wires a TRAP to STOP_SIGNAL via ISignalDO; this
        // just sets that signal over RWS and waits for TCP serving to
        // resume as confirmation the graceful exit completed. No RWS stop/
        // resetpp/start needed anymore -- the task keeps running throughout.
        function stop() {
            stopAll();
            if (!node.robot) { node.status({ fill: 'grey', shape: 'ring', text: 'stopped' }); return Promise.resolve(); }
            node.status({ fill: 'yellow', shape: 'ring', text: 'exiting EGM mode...' });

            return node.robot.rwsPost('/rw/iosystem/signals/' + STOP_SIGNAL + '/set-value', 'lvalue=1')
                .then(function() { return waitForTcpBack(8000); })
                .then(function() {
                    node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
                });
        }

        node.on('input', function(msg, send, done) {
            var payload = msg.payload;
            var action = (typeof payload === 'string' && payload) ? payload.toLowerCase()
                       : (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.action)
                           ? String(payload.action).toLowerCase()
                       : null;

            if (action === 'start') {
                start().then(function() { done(); }).catch(function(err) {
                    node.status({ fill: 'red', shape: 'ring', text: err.wrongModule ? 'wrong module' : 'error' });
                    node.error('gofa-egm: ' + err.message, msg);
                    done(err);
                });
                return;
            }
            if (action === 'stop') {
                stop().then(function() { done(); }).catch(function(err) {
                    node.status({ fill: 'red', shape: 'ring', text: 'stop error' });
                    node.error('gofa-egm: failed to cleanly exit EGM mode: ' + err.message, msg);
                    done(err);
                });
                return;
            }

            var joints = Array.isArray(payload) ? payload
                       : (payload && Array.isArray(payload.joints)) ? payload.joints
                       : null;
            if (joints) {
                if (joints.length !== 6 || joints.some(function(j) { return typeof j !== 'number' || !isFinite(j); })) {
                    node.error('gofa-egm: target must be an array of 6 finite numbers', msg);
                    return done();
                }
                if (!node._streaming) {
                    node.error('gofa-egm: not streaming yet — send {action:"start"} first', msg);
                    return done();
                }
                node._target = joints;
                return done();
            }

            node.error('gofa-egm: msg.payload must be "start", "stop", or a 6-number joint array', msg);
            done();
        });

        node.on('close', function(done) {
            node._stopped = true;
            // Only drive the full RWS recovery (stop/resetpp/start) if a
            // session was actually active -- avoids needless RWS traffic on
            // every redeploy for a node that never streamed. Best-effort:
            // never let a recovery failure block Node-RED's shutdown/redeploy.
            if (node._streaming || node._starting) {
                stop().catch(function() {}).then(function() { done(); });
            } else {
                stopAll();
                done();
            }
        });
    }
    RED.nodes.registerType('gofa-egm', GoFaEgmNode);
};

module.exports.decodeEgmRobot  = decodeEgmRobot;
module.exports.encodeEgmSensor = encodeEgmSensor;
