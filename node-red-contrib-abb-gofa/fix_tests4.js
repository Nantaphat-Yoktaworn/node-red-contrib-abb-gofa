const fs = require('fs');
let txt = fs.readFileSync('test.js', 'utf8');

// gofa-file: skips patching for binary buffers
let idx = txt.indexOf("checkAsync('gofa-file: skips patching for binary buffers");
if (idx > 0) {
    let sub = txt.substring(idx, idx + 400);
    let fixed = sub.replace(/robot:\s*'r1'/, "robot: 'r1', action: 'upload'");
    txt = txt.substring(0, idx) + fixed + txt.substring(idx + 400);
}

// gofa-file: uploads via r.rwsPut with text/plain content type
let idx2 = txt.indexOf("checkAsync('gofa-file: uploads via r.rwsPut with text/plain content type'");
if (idx2 > 0) {
    let sub2 = txt.substring(idx2, idx2 + 400);
    let fixed2 = sub2.replace(/robot:\s*'r1'/, "robot: 'r1', action: 'upload'");
    txt = txt.substring(0, idx2) + fixed2 + txt.substring(idx2 + 400);
}

// gofa-file: reports failure when rwsPut rejects
let idx3 = txt.indexOf("checkAsync('gofa-file: reports failure when rwsPut rejects'");
if (idx3 > 0) {
    let sub3 = txt.substring(idx3, idx3 + 400);
    let fixed3 = sub3.replace(/robot:\s*'r1'/, "robot: 'r1', action: 'upload'");
    txt = txt.substring(0, idx3) + fixed3 + txt.substring(idx3 + 400);
}

fs.writeFileSync('test.js', txt);
