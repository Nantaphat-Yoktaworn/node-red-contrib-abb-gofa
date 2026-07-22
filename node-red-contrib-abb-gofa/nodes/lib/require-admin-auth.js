'use strict';
// Guard for state-changing editor (httpAdmin) endpoints — the "Jog Now",
// "Move Joints Now", "Motors On", etc. buttons in the node edit dialogs.
//
// The problem: RED.auth.needsPermission(perm) is a NO-OP when Node-RED has no
// adminAuth configured, so on a default install anyone who can reach the admin
// HTTP port can curl these endpoints and move the robot. The browser confirm()
// dialogs are client-side only — not a server-side check.
//
// This wrapper makes the safe configuration the default:
//   - adminAuth configured  → behaves exactly like RED.auth.needsPermission.
//   - no adminAuth           → 403, UNLESS the target gofa-robot config node has
//                              "Allow insecure live control" ticked (escape
//                              hatch for cells protected by network isolation
//                              instead of adminAuth).
//
// Scope: editor endpoints ONLY. Deployed flows call node.on('input') on a
// completely separate path and are never affected by this guard.
module.exports = function requireAdminAuth(RED, permission) {
    var authMw = RED.auth.needsPermission(permission);
    return function(req, res, next) {
        if (RED.settings && RED.settings.adminAuth) return authMw(req, res, next);
        var node = (req.params && req.params.id) ? RED.nodes.getNode(req.params.id) : null;
        if (node && node.allowInsecureLiveControl) return next();
        return res.status(403).json({
            error: 'Live control disabled: the Node-RED admin API has no adminAuth configured. ' +
                'Configure adminAuth (recommended), or tick "Allow insecure live control" on the ' +
                'gofa-robot config node if this instance is already protected by network isolation.'
        });
    };
};
