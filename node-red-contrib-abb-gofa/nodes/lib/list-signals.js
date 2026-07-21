'use strict';
// Parses the XHTML <li class="ios-signal-li"> list from GET /rw/iosystem/signals.
module.exports = function parseSignalList(body) {
    var signals = [];
    var liRegex = /<li class="ios-signal-li"[^>]*>([\s\S]*?)<\/li>/g;
    var spanRegex = /<span class="([^"]+)"[^>]*>([^<]*)<\/span>/g;
    var liMatch;

    while ((liMatch = liRegex.exec(body)) !== null) {
        var inner = liMatch[1];
        var item = {};
        var spanMatch;
        spanRegex.lastIndex = 0;
        while ((spanMatch = spanRegex.exec(inner)) !== null) {
            var cls = spanMatch[1];
            var val = spanMatch[2].trim();
            if (cls === 'name' || cls === 'type' || cls === 'lvalue') {
                item[cls] = val;
            }
        }
        if (item.name) {
            signals.push(item);
        }
    }
    return signals;
};
