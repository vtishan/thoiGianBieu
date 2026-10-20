"use strict";

/**
 * Tạo icon ứng dụng (PNG) KHÔNG cần thư viện ngoài — tự vẽ pixel + tự đóng gói PNG.
 * Icon: nền vuông bo góc gradient (chàm → tím → lơ) + một trang giấy trắng có lề & dòng kẻ.
 * Chạy:  node scripts/gen-icon.js   ->  build/icon.png
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const W = 512, H = 512;
const px = Buffer.alloc(W * H * 4); // RGBA

function setPx(x, y, r, g, b, a) {
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

// Gradient 3 chặng: chàm -> tím -> lơ (khớp màu app).
const STOPS = [[124, 147, 255], [139, 92, 246], [45, 212, 238]];
function grad(t) {
    t = Math.max(0, Math.min(1, t));
    if (t < 0.5) { const u = t / 0.5; return [lerp(STOPS[0][0], STOPS[1][0], u), lerp(STOPS[0][1], STOPS[1][1], u), lerp(STOPS[0][2], STOPS[1][2], u)]; }
    const u = (t - 0.5) / 0.5; return [lerp(STOPS[1][0], STOPS[2][0], u), lerp(STOPS[1][1], STOPS[2][1], u), lerp(STOPS[1][2], STOPS[2][2], u)];
}
function inRounded(x, y, x0, y0, x1, y1, r) {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    const nx = x < x0 + r ? x0 + r : (x > x1 - 1 - r ? x1 - 1 - r : x);
    const ny = y < y0 + r ? y0 + r : (y > y1 - 1 - r ? y1 - 1 - r : y);
    const dx = x - nx, dy = y - ny;
    return dx * dx + dy * dy <= r * r;
}

// Trang giấy trắng
const PG = { x0: 168, y0: 132, x1: 344, y1: 384, r: 22 };
const MARGIN_X = 200;                 // đường lề
const LINE_YS = [176, 214, 252, 290, 328]; // dòng kẻ
const INK = [124, 140, 255];

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        let col = null;
        const inPage = inRounded(x, y, PG.x0, PG.y0, PG.x1, PG.y1, PG.r);
        if (inPage) {
            // dòng kẻ + lề (đè lên trang giấy)
            const onMargin = x >= MARGIN_X && x <= MARGIN_X + 3 && y >= PG.y0 + 16 && y <= PG.y1 - 16;
            let onLine = false;
            for (const ly of LINE_YS) { if (y >= ly && y <= ly + 6 && x >= 216 && x <= PG.x1 - 22) { onLine = true; break; } }
            if (onMargin) col = [236, 96, 108];       // lề đỏ nhạt
            else if (onLine) col = INK;               // dòng kẻ chàm
            else col = [255, 255, 255];               // giấy trắng
        } else if (inRounded(x, y, 16, 16, 496, 496, 116)) {
            const t = (x + y) / (W + H);
            const [r, g, b] = grad((t - 0.08) / 0.84);
            col = [r, g, b];
        }
        if (col) setPx(x, y, col[0], col[1], col[2], 255);
    }
}

// ===== Đóng gói PNG (RGBA, 8-bit) =====
function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    }
    return (~c) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, RGBA

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);

const outDir = path.resolve(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "icon.png");
fs.writeFileSync(outFile, png);
console.log("Đã tạo icon:", outFile, `(${png.length} bytes)`);
