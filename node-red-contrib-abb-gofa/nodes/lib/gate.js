'use strict';
// ponytail: default OFF -- nodes fire a bare signal to continue the flow instead of full msg.payload;
// check "Output payload" in the node's edit dialog to see full debug output.
module.exports = function gateSend(config, send) {
    function strip(msg) {
        var out = {};
        if (msg && msg._msgid !== undefined) out._msgid = msg._msgid;
        return out;
    }
    return function(msg) {
        if (config.outputPayload) return send(msg);
        if (Array.isArray(msg)) {
            return send(msg.map(function(m) { return m ? strip(m) : m; }));
        }
        return send(msg ? strip(msg) : msg);
    };
};
