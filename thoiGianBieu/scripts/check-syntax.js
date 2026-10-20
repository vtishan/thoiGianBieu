"use strict";

// Kiem tra cu phap toan bo file JS cua app.
// - File main process (CJS): node --check truc tiep.
// - File renderer (ESM, import/export): copy sang .mjs tam roi node --check.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
}

const files = [
    path.join(ROOT, "main.js"),
    path.join(ROOT, "preload.js"),
    ...walk(path.join(ROOT, "src")),
    ...walk(path.join(ROOT, "scripts")),
].filter((f, i, a) => fs.existsSync(f) && a.indexOf(f) === i);

let failed = 0;
for (const f of files) {
    const isRenderer = f.includes(path.join("src", "renderer"));
    try {
        if (isRenderer) {
            const tmp = path.join(os.tmpdir(), `chk_${Date.now()}_${path.basename(f)}.mjs`);
            fs.copyFileSync(f, tmp);
            try {
                execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
            } finally {
                fs.unlinkSync(tmp);
            }
        } else {
            execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
        }
        console.log("OK   " + path.relative(ROOT, f));
    } catch (e) {
        failed++;
        const msg = e.stderr ? e.stderr.toString() : e.message;
        console.error("FAIL " + path.relative(ROOT, f) + "\n" + msg);
    }
}

console.log(`\n${files.length - failed}/${files.length} file hợp lệ.`);
process.exit(failed ? 1 : 0);
