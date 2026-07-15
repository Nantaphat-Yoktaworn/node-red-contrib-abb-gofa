const fs = require('fs');
let txt = fs.readFileSync('test.js', 'utf8');

function findTest(name) {
    let idx = txt.indexOf(name);
    if (idx > 0) {
        console.log(name, ":\n", txt.substring(idx, idx + 400));
    } else {
        console.log("NOT FOUND:", name);
    }
}

findTest("checkAsync('gofa-file: skips patching for binary buffers");
findTest("checkAsync('gofa-file: uploads via r.rwsPut with text/plain content type'");
findTest("checkAsync('gofa-file: reports failure when rwsPut rejects'");

