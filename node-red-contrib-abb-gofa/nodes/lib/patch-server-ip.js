// Rewrite MainModule.mod's SERVER_IP constant to match the robot config
// node's IP, so it can't drift out of sync with what Node-RED actually
// connects to. No-ops (injected: false) if the constant isn't present.
function patchServerIp(text, ip) {
    var injected = false;
    var patched = text.replace(/(CONST\s+string\s+SERVER_IP\s*:=\s*")[^"]*(")/i, function(m, p1, p2) {
        injected = true;
        return p1 + ip + p2;
    });
    return { text: patched, injected: injected };
}

module.exports = patchServerIp;
