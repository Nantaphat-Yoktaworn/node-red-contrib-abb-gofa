'use strict';
// Shared jog resolution for gofa-jog, which covers all three relative-motion
// kinds behind one Target selector:
//
//   X / Y / Z      Cartesian translation, base frame, mm   (clamped 1-50)
//   RX / RY / RZ   TCP rotation, tool frame, degrees       (clamped 1-30)
//   J1 .. J6       single-joint jog, degrees               (clamped 1-30)
//
// Until 2.6.0 the joint kind lived in a separate `gofa-joint-jog` node whose
// validate/clamp/dispatch logic was a near-copy of the Cartesian one -- four
// copies of this algorithm once the two admin routes are counted. That is the
// duplication shape the 2026-08-04 audit blamed for bugs 2 and 3 ("the fix
// landed in only one of two copies"), so both nodes merged and every call site
// now goes through resolveJog().
//
// The clamps mirror JOG_MAX_MM / JOG_MAX_DEG / JOINT_MAX_DEG in
// rapid/MainModule.mod -- the controller clamps again on its side, so these are
// a courtesy (predictable token in the status bar), not the safety boundary.
var CARTESIAN = ['X', 'Y', 'Z'];
var ROTATION  = ['RX', 'RY', 'RZ'];
var MAX_MM    = 50;
var MAX_DEG   = 30;

// Every target the Target dropdown offers, in dropdown order. Exported so the
// editor panel and the tests enumerate the same list this resolver accepts.
var TARGETS = CARTESIAN.concat(ROTATION, ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']);

// Resolve a (target, dir, step) triple into the socket command object and the
// display token, or into an error. Returns either:
//   { cmd: {...}, token: 'X+10', kind: 'cart'|'rot'|'joint' }
//   { error: 'Invalid target: ...', status: 'bad target' }
// `status` is the short node.status() text the caller shows on rejection.
function resolveJog(target, dir, step) {
    // A bare number is the single-joint shorthand the old gofa-joint-jog
    // documented ("J1"-"J6", or a bare 1-6) -- keep accepting it.
    if (typeof target === 'number') target = 'J' + target;
    if (typeof target !== 'string') {
        return { error: 'Invalid or missing target: ' + target, status: 'bad target' };
    }
    var t = target.trim().toUpperCase();

    var kind;
    if (CARTESIAN.indexOf(t) !== -1) kind = 'cart';
    else if (ROTATION.indexOf(t) !== -1) kind = 'rot';
    // J-prefix optional: gofa-joint-jog parsed the joint with a bare
    // parseInt(String(joint).replace('J','')), so '3' reached the robot.
    else if (/^J?[1-6]$/.test(t)) { kind = 'joint'; t = 'J' + t.slice(-1); }
    else return { error: 'Invalid target: ' + target, status: 'bad target' };

    if (dir !== '+' && dir !== '-') {
        return { error: 'Invalid direction: ' + dir, status: 'bad dir' };
    }

    var val = parseFloat(step);
    if (isNaN(val)) {
        return { error: 'Invalid step value: ' + step, status: 'bad step' };
    }
    val = Math.max(1, Math.min(kind === 'cart' ? MAX_MM : MAX_DEG, val));

    var cmd = kind === 'joint'
        ? { cmd: 'jointjog', joint: parseInt(t.substring(1), 10), sgn: dir, val: val }
        // The `jog` wire command takes the bare axis letter plus a rot flag,
        // NOT the RX/RY/RZ spelling -- RY goes out as { axis: 'Y', rot: true }.
        : { cmd: 'jog', axis: kind === 'rot' ? t.substring(1) : t, sgn: dir, val: val, rot: kind === 'rot' };

    return { cmd: cmd, token: t + dir + val, kind: kind };
}

// Pick the target out of a msg.payload / admin-route body. `target` is the
// field the merged node writes; `axis` and `joint` are what pre-2.6.0 flows
// and the two old nodes' documented payloads send, so both still work.
function pickTarget(src, fallback) {
    if (!src || typeof src !== 'object') return fallback;
    if (src.target !== undefined) return src.target;
    if (src.axis   !== undefined) return src.axis;
    if (src.joint  !== undefined) return src.joint;
    return fallback;
}

module.exports = resolveJog;
module.exports.resolveJog = resolveJog;
module.exports.pickTarget = pickTarget;
module.exports.TARGETS    = TARGETS;
module.exports.MAX_MM     = MAX_MM;
module.exports.MAX_DEG    = MAX_DEG;
