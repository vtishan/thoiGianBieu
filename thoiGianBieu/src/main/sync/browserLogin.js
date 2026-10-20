"use strict";

/**
 * Quản lý cửa sổ trình duyệt thật cho:
 *   1) Đăng nhập CMC MỘT LẦN bằng tài khoản Microsoft: mở thẳng trang đăng nhập Microsoft.
 *      Vì cả 4 portal (iu / elearning / lms / edux) đều dùng chung Microsoft SSO nên chỉ cần
 *      đăng nhập 1 lần, sau đó mở portal khác là tự động vào. Session được lưu (persist).
 *   2) Kết nối Gemini tự động: mở gemini.google.com, TỰ trích cookie từ session Electron.
 *   3) CÀO TOÀN BỘ dữ liệu: bắt mọi phản hồi API/JSON của portal (qua Chrome DevTools Protocol)
 *      + tự đi qua nhiều trang + chụp DOM. Dữ liệu chi tiết của cổng đào tạo thường nằm trong
 *      các JSON API nên cách này lấy được đầy đủ (điểm, học phí, hồ sơ...).
 */

const { BrowserWindow, session } = require("electron");

const CMC_PARTITION = "persist:cmc-portal";
const GEMINI_PARTITION = "persist:gemini";

const GEMINI_WANTED = new Set([
    "__Secure-1PAPISID", "__Secure-3PAPISID",
    "__Secure-1PSIDCC", "__Secure-3PSIDCC",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS",
    "__Secure-1PSID", "__Secure-3PSID",
    "SAPISID", "APISID", "SIDCC", "HSID", "SSID", "SID", "NID",
]);

// Bỏ qua các tài nguyên không phải dữ liệu (ảnh, font, css, analytics...).
const SKIP_URL = /google-analytics|googletagmanager|gstatic|fonts\.googleapis|doubleclick|facebook\.|\.woff2?|\.ttf|\.png|\.jpe?g|\.gif|\.svg|\.css|\.ico|\.map/i;

let cmcWindow = null;
let geminiWindow = null;
const netState = new Map(); // webContents.id -> { responses: [], pending: {} }

// ===== Script chạy trong trang =====

/**
 * Hook cài SỚM vào trang: bắt dữ liệu ĐÃ GIẢI MÃ ngay khi site tự giải mã để hiển thị.
 * Vì cổng IU (APIS) mã hóa payload rồi giải mã bằng JS phía client, ta chặn tại các điểm:
 *   - JSON.parse: site luôn parse chuỗi đã giải mã -> lấy được object gốc.
 *   - CryptoJS.AES.decrypt: lấy thẳng plaintext (nếu CryptoJS là biến toàn cục).
 *   - fetch / XMLHttpRequest: lưu cả body thô (để đối chiếu / phòng khi cần key).
 * Cách này KHÔNG cần biết key giải mã.
 */
function portalHookScript() {
    if (window.__CMC_HOOK__) return true;
    window.__CMC_HOOK__ = true;
    var cap = (window.__CMC_CAP__ = { json: [], raw: [], plain: [] });
    var LIMIT = 400;
    var MAXLEN = 45000;

    try {
        var origParse = JSON.parse;
        JSON.parse = function (text, reviver) {
            var result = origParse.call(JSON, text, reviver);
            try {
                if (result && typeof result === "object" && cap.json.length < LIMIT) {
                    var s = JSON.stringify(result);
                    if (s && s.length > 20) cap.json.push(s.slice(0, MAXLEN));
                }
            } catch (e) {}
            return result;
        };
    } catch (e) {}

    try {
        if (window.CryptoJS && window.CryptoJS.AES && !window.CryptoJS.AES.__cmcWrapped) {
            var origDec = window.CryptoJS.AES.decrypt;
            window.CryptoJS.AES.decrypt = function () {
                var r = origDec.apply(this, arguments);
                try {
                    var s = r.toString(window.CryptoJS.enc.Utf8);
                    if (s && s.length > 20 && cap.plain.length < LIMIT) cap.plain.push(s.slice(0, MAXLEN));
                } catch (e) {}
                return r;
            };
            window.CryptoJS.AES.__cmcWrapped = true;
        }
    } catch (e) {}

    try {
        if (window.fetch) {
            var of = window.fetch;
            window.fetch = function () {
                return of.apply(this, arguments).then(function (resp) {
                    try {
                        resp.clone().text().then(function (t) {
                            if (t && cap.raw.length < LIMIT) cap.raw.push({ url: resp.url || "", body: String(t).slice(0, MAXLEN) });
                        }).catch(function () {});
                    } catch (e) {}
                    return resp;
                });
            };
        }
    } catch (e) {}

    try {
        var oOpen = XMLHttpRequest.prototype.open;
        var oSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__cmcUrl = u; return oOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
            var xhr = this;
            this.addEventListener("load", function () {
                try {
                    var t = xhr.responseText;
                    if (t && cap.raw.length < LIMIT) cap.raw.push({ url: xhr.__cmcUrl || "", body: String(t).slice(0, MAXLEN) });
                } catch (e) {}
            });
            return oSend.apply(this, arguments);
        };
    } catch (e) {}

    return true;
}

function pageCaptureScript() {
    function textOf(el) {
        return (el && el.innerText ? el.innerText : "").replace(/\u00a0/g, " ").trim();
    }
    const tables = [];
    for (const table of Array.from(document.querySelectorAll("table")).slice(0, 15)) {
        const rows = [];
        for (const tr of Array.from(table.querySelectorAll("tr")).slice(0, 300)) {
            const cells = Array.from(tr.querySelectorAll("th,td")).map((td) => textOf(td));
            if (cells.some((c) => c)) rows.push(cells);
        }
        if (rows.length) tables.push(rows);
    }
    let bodyText = "";
    try {
        bodyText = (document.body && document.body.innerText ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n");
    } catch (e) {
        bodyText = "";
    }
    const captured = window.__CMC_CAP__ || { json: [], raw: [], plain: [] };
    return { url: location.href, title: document.title, tables, text: bodyText.slice(0, 15000), captured };
}

// Thu thập link: tách "full" (điều hướng trang) và "hashes" (mục SPA cùng trang, vd #hoso, #tkb).
function collectLinksScript() {
    var origin = location.origin;
    var path = location.pathname;
    var full = [];
    var hashes = [];
    Array.prototype.forEach.call(document.querySelectorAll("a[href]"), function (a) {
        var raw = a.getAttribute("href") || "";
        if (raw.charAt(0) === "#" && raw.length > 1) { hashes.push(raw); return; }
        var href = a.href || "";
        if (!/^https?:/i.test(href)) return;
        try {
            var u = new URL(href);
            if (u.origin === origin && u.pathname === path && u.hash && u.hash.length > 1) { hashes.push(u.hash); return; }
        } catch (e) { /* ignore */ }
        full.push(href);
    });
    var uniq = function (arr) { return arr.filter(function (v, i, s) { return s.indexOf(v) === i; }); };
    return { full: uniq(full), hashes: uniq(hashes) };
}

// Tìm & bấm nút "Sign in using Microsoft" trên trang đăng nhập của portal (APIS).
// Nhờ đó portal tự SSO qua phiên Microsoft đã đăng nhập (không phải gõ lại mật khẩu).
function clickMsSignInScript() {
    var kw = /microsoft|đăng nhập.*microsoft|sign in using microsoft|office ?365|azure/i;
    var sel = "a, button, input[type=button], input[type=submit], div[role=button], span[role=button], img";
    var els = Array.prototype.slice.call(document.querySelectorAll(sel));
    for (var i = 0; i < els.length; i++) {
        var e = els[i];
        var t = (e.innerText || e.value || e.getAttribute("aria-label") || e.title || e.alt || "").trim();
        if (t && kw.test(t)) {
            var clickable = e.closest && e.closest("a,button,[role=button]") ? e.closest("a,button,[role=button]") : e;
            clickable.click();
            return t || "clicked";
        }
    }
    var links = Array.prototype.slice.call(document.querySelectorAll("a[href]"));
    for (var j = 0; j < links.length; j++) {
        if (/microsoft|oauth|external|azuread|\bsso\b|signin-oidc|openid/i.test(links[j].href)) {
            links[j].click();
            return links[j].href;
        }
    }
    return false;
}

// ===== Giải mã APIS =====
// Cơ chế (lấy từ JS portal): giải mã = base64-decode rồi XOR với KEY (chuỗi, lặp lại).
// Có NHIỀU key ẩn:
//   - "A" (0x41): dùng cho tên hàm/endpoint (đã xác minh: "LayDanhSachDuLieu...").
//   - key theo ngày = "" + năm + (tháng)  (vd tháng 7/2026 -> "20267"): dùng cho payload.
// Ta thử tất cả key, chọn bản giải mã ĐỌC ĐƯỢC.
function buildApisKeys() {
    const keys = ["A"];
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    keys.push("" + y + m); // key hiện tại (ưu tiên)
    for (const yr of [y, y - 1]) for (let mm = 1; mm <= 12; mm++) { const k = "" + yr + mm; if (!keys.includes(k)) keys.push(k); }
    return keys;
}
const APIS_KEYS = buildApisKeys();

function xorB64(b64, keyStr) {
    try {
        const buf = Buffer.from(String(b64), "base64");
        if (!buf.length) return "";
        const key = Buffer.from(String(keyStr), "utf8");
        const out = Buffer.alloc(buf.length);
        for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
        return out.toString("utf8");
    } catch {
        return "";
    }
}
function apisDecodeBest(b64) {
    let best = "";
    for (const k of APIS_KEYS) {
        const d = xorB64(b64, k);
        if (decodedIsUseful(d) && d.length > best.length) best = d;
    }
    return best;
}
function looksBase64(s) {
    if (typeof s !== "string") return false;
    const t = s.replace(/\s/g, "");
    return t.length >= 16 && t.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t);
}
function decodedIsUseful(s) {
    if (!s || s.length < 8) return false;
    let printable = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 0xa0) printable++;
    }
    return printable / s.length > 0.9 && /[{[]|":"|[A-Za-zÀ-ỹ]{4}/.test(s);
}
// Tìm & giải mã các chuỗi bị mã hóa trong 1 response (cả khi bọc trong JSON {"Data":"..."} ).
function apisExtractDecoded(rawText) {
    const results = [];
    const raw = String(rawText || "");
    const tryPush = (str) => {
        if (looksBase64(str)) {
            const d = apisDecodeBest(str.replace(/\s/g, ""));
            if (d) results.push(d);
        }
    };
    if (raw.trim() && !raw.trim().startsWith("{") && !raw.trim().startsWith("[")) tryPush(raw.trim());
    try {
        const obj = JSON.parse(raw);
        const scan = (v, depth) => {
            if (depth > 6 || v == null) return;
            if (typeof v === "string") tryPush(v);
            else if (Array.isArray(v)) v.forEach((x) => scan(x, depth + 1));
            else if (typeof v === "object") Object.values(v).forEach((x) => scan(x, depth + 1));
        };
        scan(obj, 0);
    } catch {
        /* không phải JSON */
    }
    return results.slice(0, 40);
}

async function extractCookieMap(partition, url, wanted) {
    const ses = session.fromPartition(partition);
    let list = [];
    try {
        list = await ses.cookies.get({ url });
    } catch {
        list = [];
    }
    const map = {};
    for (const c of list) {
        if (!wanted || wanted.has(c.name)) map[c.name] = c.value;
    }
    return map;
}

// ===== Bắt dữ liệu mạng (CDP) =====
function startNetworkCapture(win) {
    const wc = win.webContents;
    if (netState.has(wc.id)) return;
    const state = { responses: [], pending: {} };
    netState.set(wc.id, state);

    try {
        wc.debugger.attach("1.3");
    } catch {
        // DevTools có thể đang mở -> bỏ qua bắt mạng, vẫn chụp DOM được.
        netState.delete(wc.id);
        return;
    }

    wc.debugger.on("message", async (_e, method, params) => {
        try {
            if (method === "Network.responseReceived") {
                const url = params.response && params.response.url;
                const mime = (params.response && params.response.mimeType) || "";
                if (url && !SKIP_URL.test(url) && /json|text\/plain/i.test(mime)) {
                    state.pending[params.requestId] = { url, mime };
                }
            } else if (method === "Network.loadingFinished") {
                const meta = state.pending[params.requestId];
                if (!meta) return;
                delete state.pending[params.requestId];
                try {
                    const body = await wc.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId });
                    let text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
                    if (text && text.trim().length > 2) {
                        const decoded = apisExtractDecoded(text); // tự giải mã payload APIS (base64 + XOR 0x41)
                        state.responses.push({ url: meta.url, mime: meta.mime, body: text.slice(0, 50000), decoded });
                        if (state.responses.length > 250) state.responses.shift();
                    }
                } catch {
                    /* body đã bị xoá */
                }
            }
        } catch {
            /* ignore */
        }
    });

    wc.debugger.on("detach", () => netState.delete(wc.id));
    wc.debugger.sendCommand("Network.enable").catch(() => {});
}

function getNetworkData(win) {
    const state = netState.get(win.webContents.id);
    return state ? state.responses.slice() : [];
}
function clearNetworkData(win) {
    const state = netState.get(win.webContents.id);
    if (state) { state.responses = []; state.pending = {}; }
}

// ===== CMC (một cửa sổ dùng chung) =====
function openCmc(url, opts = {}) {
    let win = cmcWindow;
    if (!win || win.isDestroyed()) {
        win = new BrowserWindow({
            width: 1180,
            height: 860,
            show: !opts.hidden, // ẩn khi cào ngầm (đã đăng nhập từ trước)
            title: "Đăng nhập CMC (Microsoft)",
            autoHideMenuBar: true,
            webPreferences: {
                partition: CMC_PARTITION,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false, // vẫn chạy khi ẩn
            },
        });
        cmcWindow = win;
        startNetworkCapture(win);
        const injectHook = () => {
            if (win.isDestroyed()) return;
            win.webContents.executeJavaScript(`(${portalHookScript.toString()})()`, true).catch(() => {});
        };
        const report = () => {
            if (win.isDestroyed()) return;
            injectHook();
            try {
                if (opts.onNavigate) opts.onNavigate(win.webContents.getURL());
            } catch { /* ignore */ }
        };
        win.webContents.on("dom-ready", injectHook);
        win.webContents.on("did-navigate", report);
        win.webContents.on("did-navigate-in-page", report);
        win.webContents.on("did-stop-loading", report);
        win.on("closed", () => { cmcWindow = null; });
    }
    if (url) win.loadURL(url);
    if (!opts.hidden) win.focus();
    return win;
}

function hideCmc() {
    if (cmcWindow && !cmcWindow.isDestroyed() && cmcWindow.isVisible()) cmcWindow.hide();
}
function showCmc() {
    if (cmcWindow && !cmcWindow.isDestroyed()) { cmcWindow.show(); cmcWindow.focus(); }
}
// Đóng HẲN cửa sổ CMC nhưng GIỮ phiên đăng nhập (partition persist) -> lần sau SSO im lặng.
// Dùng cho đồng bộ thụ động: cào ngầm xong thì tắt trình duyệt đi.
function closeCmc() {
    if (cmcWindow && !cmcWindow.isDestroyed()) {
        try { cmcWindow.destroy(); } catch { /* ignore */ }
    }
    cmcWindow = null;
}

function getCmc() {
    return cmcWindow && !cmcWindow.isDestroyed() ? cmcWindow : null;
}
function isCmcOpen() {
    return !!getCmc();
}
function requireCmc() {
    const w = getCmc();
    if (!w) {
        const e = new Error("Chưa mở cửa sổ CMC. Hãy đăng nhập Microsoft trước.");
        e.code = "SYNC_NO_WINDOW";
        throw e;
    }
    return w;
}
function navigateCmc(url) {
    const w = requireCmc();
    w.loadURL(url);
    w.focus();
    return w;
}
async function navigateCmcWait(url) {
    const w = requireCmc();
    await loadAndWait(w, url);
    return w;
}

// Kiểm tra phiên THẬT của từng portal. Chỉ nhìn domain là không đủ: eLearning
// vẫn render trang chủ khi chưa có token và mọi API phía sau sẽ trả 401.
function portalAuthStateScript(portalKey) {
    try {
        var key = String(portalKey || "");
        var href = location.href || "";
        var path = location.pathname || "";
        if (/login\.microsoftonline\.com|login\.live\.com/i.test(href)) return false;
        if (key === "elearning") {
            var token = localStorage.getItem("token-lms");
            if (!token) return false;
            try {
                var encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
                while (encoded.length % 4) encoded += "=";
                var body = JSON.parse(atob(encoded));
                if (body.exp && body.exp * 1000 <= Date.now() + 30000) return false;
            } catch (e) {}
            return true;
        }
        if (key === "edux") {
            return localStorage.getItem("isAuthenticated") === "true" && !!localStorage.getItem("user");
        }
        if (key === "lms") {
            return !/\/login/i.test(path) && !!(window.ENV && (window.ENV.current_user_id || window.ENV.current_user));
        }
        return /cmcu\.edu\.vn/i.test(location.hostname) && !/login|signin|sign-in/i.test(href);
    } catch (e) {
        return false;
    }
}

async function portalAuthState(win, portalKey) {
    try {
        return !!(await win.webContents.executeJavaScript(
            `(${portalAuthStateScript.toString()})(${JSON.stringify(portalKey || "")})`,
            true
        ));
    } catch {
        return false;
    }
}

async function waitForPortalAuth(win, portalKey, timeout = 120000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (win.isDestroyed()) return false;
        if (await portalAuthState(win, portalKey)) return true;
        await new Promise((resolve) => setTimeout(resolve, 650));
    }
    return false;
}

// Hoàn tất SSO riêng của từng ứng dụng. Phiên Microsoft được dùng lại nên đa số
// chỉ cần bấm nút một lần; nếu tenant yêu cầu chọn tài khoản, cửa sổ sẽ hiện.
async function ensurePortalAuth(portalKey) {
    const win = requireCmc();
    const key = String(portalKey || "");
    if (await portalAuthState(win, key)) return true;

    const loginPage = key === "elearning"
        ? "https://elearning.cmcu.edu.vn/auth/sign-in?redirect=%2Fmy-assignment"
        : key === "edux"
            ? "https://edux.cmcu.edu.vn/login"
            : "";
    if (loginPage && !/microsoftonline|login\.live/i.test(win.webContents.getURL())) {
        await loadAndWait(win, loginPage);
    }

    // Cho React/MSAL dựng nút rồi tự bấm. Nếu chưa thấy, vẫn hiện cửa sổ để
    // người dùng thao tác và vòng chờ sẽ xác nhận bằng token thật.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await win.webContents.executeJavaScript(`(${clickMsSignInScript.toString()})()`, true).catch(() => false);
    showCmc();
    const ok = await waitForPortalAuth(win, key, 120000);
    if (ok) hideCmc();
    return ok;
}

async function invalidatePortalAuth(portalKey) {
    const win = requireCmc();
    const key = String(portalKey || "");
    try {
        await win.webContents.executeJavaScript(`(function(key){
            try {
                if (key === "elearning") {
                    localStorage.removeItem("token-lms");
                    localStorage.removeItem("xsrf-token");
                    localStorage.removeItem("oauth-login");
                } else if (key === "edux") {
                    localStorage.setItem("isAuthenticated", "false");
                    localStorage.removeItem("user");
                }
                return true;
            } catch (e) { return false; }
        })(${JSON.stringify(key)})`, true);
    } catch {
        /* ignore */
    }
    return true;
}
async function captureCmc() {
    const w = requireCmc();
    return w.webContents.executeJavaScript(`(${pageCaptureScript.toString()})()`, true);
}

// Điều hướng vào một mục SPA theo hash (vd #hoso): ưu tiên click đúng link, nếu không thì set location.hash.
async function visitHash(win, hash, waitMs) {
    const h = JSON.stringify(String(hash));
    const script =
        "(function(hh){try{" +
        "var a=null;try{a=document.querySelector('a[href='+JSON.stringify(hh)+']');}catch(e){}" +
        "if(!a){var all=document.querySelectorAll('a[href]');for(var i=0;i<all.length;i++){var r=all[i].getAttribute('href')||'';if(r===hh||r.slice(-hh.length)===hh){a=all[i];break;}}}" +
        "if(a){a.click();return 'click';}" +
        "location.hash=hh;try{window.dispatchEvent(new HashChangeEvent('hashchange'));}catch(e){}return 'hash';" +
        "}catch(e){return 'err';}})(" + h + ")";
    await win.webContents.executeJavaScript(script, true).catch(() => {});
    await new Promise((r) => setTimeout(r, waitMs || 2400)); // chờ SPA render + XHR
}

function loadAndWait(win, url, timeout = 18000) {
    return new Promise((resolve) => {
        let done = false;
        const wc = win.webContents;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            wc.removeListener("did-stop-loading", onStop);
            setTimeout(resolve, 700); // chờ thêm cho XHR sau khi tải xong (đã rút gọn để cào nhanh)
        };
        const onStop = () => finish();
        const timer = setTimeout(finish, timeout);
        wc.on("did-stop-loading", onStop);
        wc.loadURL(url).catch(() => finish());
    });
}

/**
 * Cào sâu: chụp trang hiện tại + tự đi qua nhiều link nội bộ + gom toàn bộ JSON API đã bắt.
 */
async function deepCaptureCmc(opts = {}) {
    const win = requireCmc();
    const maxPages = opts.maxPages || 8;
    const maxHashes = opts.maxHashes || 12;
    const waitMs = opts.waitMs || 2400;
    startNetworkCapture(win);

    const pages = [];
    const seen = new Set();
    const decryptedSet = new Set(); // dữ liệu đã giải mã (JSON.parse + CryptoJS), khử trùng lặp

    const absorb = (cap) => {
        if (!cap) return;
        pages.push({ url: cap.url, title: cap.title, tables: cap.tables, text: cap.text });
        const c = cap.captured || {};
        for (const s of c.json || []) decryptedSet.add(s);
        for (const s of c.plain || []) decryptedSet.add(s);
    };

    const prefer = (opts.prefer || []).map((s) => String(s).toLowerCase());
    const score = (u) => { const lu = String(u).toLowerCase(); return prefer.reduce((n, k) => n + (lu.indexOf(k) !== -1 ? 1 : 0), 0); };
    const badHash = /logout|signout|dangxuat|thoat|matkhau|mat-?khau|doimk|password|changepass|baomat|security/i;

    absorb(await captureCmc());
    seen.add((pages[0] && pages[0].url ? pages[0].url : "").split("#")[0]);

    let origin = "";
    try { origin = new URL(win.webContents.getURL()).origin; } catch { origin = ""; }

    let linkData = { full: [], hashes: [] };
    try { linkData = await win.webContents.executeJavaScript(`(${collectLinksScript.toString()})()`, true); } catch { linkData = { full: [], hashes: [] }; }

    // 1) Các mục SPA theo hash (vd #hoso, #tkb, #lichthi) — quan trọng cho cổng APIS.
    let hashes = (linkData.hashes || []).slice();
    for (const s of opts.seedHashes || []) if (!hashes.includes(s)) hashes.unshift(s); // mồi hash chắc chắn cần (vd #hoso)
    hashes = hashes.filter((hh) => !badHash.test(hh));
    if (prefer.length) hashes.sort((a, b) => score(b) - score(a));
    hashes = hashes.slice(0, maxHashes);

    // 2) Trang điều hướng đầy đủ (khác path).
    const pool = [];
    for (const l of linkData.full || []) {
        const norm = String(l).split("#")[0];
        if (seen.has(norm)) continue;
        if (origin && !norm.startsWith(origin)) continue;
        if (/logout|signout|dang.?xuat|thoat|doi.?mat.?khau|matkhau|mat-?khau|change.?pass|doimk|resetpass|bao.?mat|security|\.pdf|\.docx?|\.xlsx?|\.pptx?|\.zip|\.rar|mailto:|tel:/i.test(l)) continue;
        seen.add(norm);
        pool.push(norm);
        if (pool.length >= 60) break;
    }
    if (prefer.length) pool.sort((a, b) => score(b) - score(a));
    const candidates = pool.slice(0, maxPages);

    const total = 1 + hashes.length + candidates.length;
    let step = 1;
    if (opts.onProgress) opts.onProgress({ visited: step, total });

    for (const hsh of hashes) {
        try { await visitHash(win, hsh, waitMs); absorb(await captureCmc()); } catch { /* bỏ qua */ }
        step++;
        if (opts.onProgress) opts.onProgress({ visited: step, total });
    }
    for (const url of candidates) {
        try { await loadAndWait(win, url); await new Promise((r) => setTimeout(r, Math.max(0, waitMs - 1400))); absorb(await captureCmc()); } catch { /* bỏ qua */ }
        step++;
        if (opts.onProgress) opts.onProgress({ visited: step, total });
    }

    const api = getNetworkData(win); // bản thô (có thể vẫn mã hóa)
    for (const r of api) for (const d of r.decoded || []) decryptedSet.add(d); // gộp payload đã giải mã
    return { pages, api, decrypted: Array.from(decryptedSet), origin };
}

/**
 * BẮT API theo từng route SPA (KHÔNG scan DOM -> nhẹ, đỡ tốn dung lượng).
 * Điều hướng qua từng route để kích hoạt lời gọi API, rồi thu + giải mã response.
 * @param {string[]} routes vd ["#hoso","#lichhoc","#lichthi","#diemhoc"]
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chờ tới khi mạng "rảnh": không có response API mới trong idleMs (nhanh hơn chờ cố định).
async function waitNetIdle(win, maxMs, idleMs) {
    maxMs = maxMs || 6000;
    idleMs = idleMs || 700;
    const start = Date.now();
    let last = -1;
    let lastChange = Date.now();
    while (Date.now() - start < maxMs) {
        await sleep(180);
        const n = getNetworkData(win).length;
        if (n !== last) { last = n; lastChange = Date.now(); }
        else if (Date.now() - lastChange >= idleMs) break;
    }
}

// Chỉ đọc dữ liệu đã giải mã trong trang (KHÔNG dựng bảng/text DOM -> nhẹ).
function readCapturedInPage() {
    return window.__CMC_CAP__ || { json: [], plain: [], raw: [] };
}
async function readHook(win, set) {
    try {
        const c = await win.webContents.executeJavaScript(`(${readCapturedInPage.toString()})()`, true);
        for (const s of (c && c.json) || []) set.add(s);
        for (const s of (c && c.plain) || []) set.add(s);
    } catch { /* bỏ qua */ }
}

async function captureRoutesApi(routes, opts = {}) {
    const win = requireCmc();
    startNetworkCapture(win);
    clearNetworkData(win); // bắt đầu sạch để chỉ lấy dữ liệu của lần này
    const list = Array.isArray(routes) && routes.length ? routes : ["#hoso"];
    const decryptedSet = new Set();

    // Chờ trang nạp xong (các API mặc định) rồi đọc. Thoát sớm khi mạng rảnh -> nhanh.
    const routeWaitMs = Math.max(1200, Number(opts.waitMs) || 3200);
    await waitNetIdle(win, routeWaitMs, 700);
    await readHook(win, decryptedSet);

    let step = 0;
    for (const hsh of list) {
        step++;
        if (opts.onProgress) opts.onProgress({ visited: step, total: list.length, route: hsh });
        // Cho SPA đủ thời gian đổi route/render trước khi xét mạng rảnh. Trước đây
        // waitMs của caller bị bỏ qua và mỗi route chỉ được chờ 200 + 450 ms.
        try { await visitHash(win, hsh, Math.min(1200, Math.max(500, routeWaitMs / 3))); } catch { /* bỏ qua */ }
        await waitNetIdle(win, routeWaitMs, 900); // chờ API của route trả về, thoát sớm khi mạng rảnh
        await readHook(win, decryptedSet);
    }

    const api = getNetworkData(win);
    for (const r of api) for (const d of r.decoded || []) decryptedSet.add(d);
    let url = "";
    try { url = win.webContents.getURL(); } catch { url = ""; }
    return { api, decrypted: Array.from(decryptedSet), pages: [], url };
}

/**
 * Gọi thẳng REST API của portal TỪ TRONG trang đã đăng nhập (dùng cookie/phiên hiện tại).
 * Dùng cho các portal SPA có API rõ ràng (LMS Canvas /api/v1, EduX /api, eLearning api.elearning...).
 * endpoints: mảng URL (tương đối với origin trang hiện tại, hoặc tuyệt đối cho api host khác).
 * Trả về: [{ url, status, body }] — body là text (JSON) đã lấy được.
 */
async function fetchJsonInPortal(endpoints) {
    const win = requireCmc();
    const list = JSON.stringify(Array.isArray(endpoints) ? endpoints : []);
    const script =
        "(async function(){var eps=" + list + ";var out=[];" +
        "for(var i=0;i<eps.length;i++){try{" +
        "var r=await fetch(eps[i],{headers:{Accept:'application/json'},credentials:'include'});" +
        "var t=await r.text();out.push({url:eps[i],status:r.status,body:String(t).slice(0,500000)});" +
        "}catch(e){out.push({url:eps[i],status:0,error:String((e&&e.message)||e)});}}" +
        "return out;})()";
    try {
        return await win.webContents.executeJavaScript(script, true);
    } catch (e) {
        return [];
    }
}

// Mở các trang dữ liệu của SPA và thu chính các JSON request mà frontend dùng.
// Cách này giữ nguyên Authorization/Tenant headers do interceptor của ứng dụng
// tạo ra, thay vì tự fetch API rồi bị 400/401.
async function captureApiPages(pages, opts = {}) {
    const win = requireCmc();
    startNetworkCapture(win);
    clearNetworkData(win);
    const base = new URL(win.webContents.getURL()).origin;
    for (const page of pages || []) {
        const url = /^https?:/i.test(page) ? page : base + (String(page).startsWith("/") ? page : "/" + page);
        await loadAndWait(win, url);
        await waitNetIdle(win, Math.max(2500, Number(opts.waitMs) || 5000), 900);
    }
    return getNetworkData(win).map((r) => ({ url: r.url, status: 200, body: r.body }));
}

function readCmcCookies() {
    return extractCookieMap(CMC_PARTITION, "https://cmcu.edu.vn", null);
}

/**
 * Tự nạp cookie Gemini đã lưu (persist) từ lần đăng nhập trước — KHÔNG mở cửa sổ, không cần bấm.
 * Trả về map cookie; có __Secure-1PSID nếu trước đây đã đăng nhập Google trong app.
 * Lưu ý: Gemini bắt buộc đã từng đăng nhập thì mới có cookie này (không có cách dùng ẩn danh).
 */
async function autoLoadGeminiCookies() {
    return extractCookieMap(GEMINI_PARTITION, "https://gemini.google.com", GEMINI_WANTED);
}

// ===== Gemini (tự trích cookie) =====
async function connectGemini(opts = {}) {
    return new Promise((resolve, reject) => {
        let win = geminiWindow;
        if (!win || win.isDestroyed()) {
            win = new BrowserWindow({
                width: 1080,
                height: 800,
                title: "Kết nối Trợ lý AI",
                autoHideMenuBar: true,
                webPreferences: {
                    partition: GEMINI_PARTITION,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            });
            geminiWindow = win;
        }
        win.loadURL("https://gemini.google.com/app");
        win.focus();

        let done = false;
        let closedByUs = false;
        const started = Date.now();
        const TIMEOUT = 5 * 60 * 1000;

        const finish = () => {
            clearInterval(timer);
            closedByUs = true;
            if (win && !win.isDestroyed()) win.close();
        };

        const timer = setInterval(async () => {
            if (done) return;
            if (Date.now() - started > TIMEOUT) {
                done = true;
                finish();
                reject(Object.assign(new Error("Hết thời gian chờ kết nối tài khoản AI."), { code: "GEMINI_TIMEOUT" }));
                return;
            }
            const map = await extractCookieMap(GEMINI_PARTITION, "https://gemini.google.com", GEMINI_WANTED);
            const has = !!map["__Secure-1PSID"];
            if (opts.onProgress) opts.onProgress({ type: "gemini", stage: has ? "found" : "waiting" });
            if (has) {
                done = true;
                finish();
                resolve(map);
            }
        }, 2000);

        win.on("closed", () => {
            geminiWindow = null;
            if (!done && !closedByUs) {
                clearInterval(timer);
                reject(Object.assign(new Error("Bạn đã đóng cửa sổ trước khi đăng nhập Google xong."), { code: "GEMINI_CLOSED" }));
            }
        });
    });
}

// ===== Outlook: lấy access token để gửi mail tự động qua REST API =====
let outlookTokenCache = { token: "", exp: 0 };

function jwtExp(token) {
    try {
        const p = JSON.parse(Buffer.from(String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        return (p.exp || 0) * 1000;
    } catch { return 0; }
}

/**
 * Lấy Bearer token của Outlook (aud=outlook.office.com, scope Mail.Send) bằng cách mở Outlook Web
 * ẩn (dùng chung phiên Microsoft đã đăng nhập với portal) và BẮT header Authorization mà OWA tự
 * gửi trong các lời gọi service.svc (qua CDP). Token được cache tới khi gần hết hạn.
 */
async function getOutlookToken(timeoutMs = 35000) {
    // Còn hạn (trừ hao 5 phút) -> dùng lại.
    if (outlookTokenCache.token && outlookTokenCache.exp - Date.now() > 5 * 60 * 1000) return outlookTokenCache.token;

    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            width: 900, height: 700, show: false,
            webPreferences: { partition: CMC_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
        });
        const wc = win.webContents;
        let done = false;
        const finish = (token, err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { wc.debugger.detach(); } catch { /* ignore */ }
            if (!win.isDestroyed()) win.destroy();
            if (err) reject(err);
            else { outlookTokenCache = { token, exp: jwtExp(token) || (Date.now() + 30 * 60 * 1000) }; resolve(token); }
        };
        const timer = setTimeout(() => finish(null, Object.assign(new Error("Không lấy được quyền gửi từ Outlook (hết thời gian). Hãy đăng nhập Microsoft ở tab Đồng bộ portal trước."), { code: "OUTLOOK_NO_TOKEN" })), timeoutMs);

        try { wc.debugger.attach("1.3"); } catch (e) { finish(null, new Error("Không mở được trình gỡ lỗi để lấy token.")); return; }
        wc.debugger.on("message", (_e, method, params) => {
            if (method !== "Network.requestWillBeSent") return;
            const req = params.request || {};
            const headers = req.headers || {};
            const auth = headers.Authorization || headers.authorization || "";
            if (/^Bearer /i.test(auth) && /outlook\.office\.com/i.test(req.url || "")) {
                finish(auth.replace(/^Bearer\s+/i, ""));
            }
        });
        wc.debugger.sendCommand("Network.enable").catch(() => {});
        win.loadURL("https://outlook.office.com/mail/");
    });
}

function clearOutlookToken() {
    outlookTokenCache = { token: "", exp: 0 };
}

/**
 * Mở Outlook Web (đã đăng nhập bằng chính tài khoản Microsoft của trường — dùng chung partition
 * với portal) ở màn hình SOẠN THƯ, điền sẵn người nhận/tiêu đề/nội dung. Sinh viên chỉ cần
 * đính kèm ảnh minh chứng rồi bấm Gửi. Cách này gửi bằng đúng email trường, không cần App Password.
 */
function openOutlookCompose(opts = {}) {
    const params = new URLSearchParams();
    if (opts.to) params.set("to", opts.to);
    if (opts.subject) params.set("subject", opts.subject);
    if (opts.body) params.set("body", opts.body);
    const url = "https://outlook.office.com/mail/deeplink/compose?" + params.toString();
    const win = new BrowserWindow({
        width: 1040,
        height: 820,
        title: "Soạn email xin nghỉ (Outlook)",
        autoHideMenuBar: true,
        webPreferences: { partition: CMC_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadURL(url);
    win.focus();
    return { ok: true, opened: true };
}

function closeAll() {
    if (cmcWindow && !cmcWindow.isDestroyed()) cmcWindow.close();
    if (geminiWindow && !geminiWindow.isDestroyed()) geminiWindow.close();
    cmcWindow = null;
    geminiWindow = null;
}

/**
 * Đăng xuất khỏi portal CMC: đóng cửa sổ và XOÁ toàn bộ session của partition CMC
 * (cookie, localStorage, cache...). Lần sau đồng bộ sẽ phải đăng nhập Microsoft lại.
 * KHÔNG đụng tới session Gemini (partition riêng) nên AI vẫn giữ nguyên.
 */
async function logoutCmc() {
    if (cmcWindow && !cmcWindow.isDestroyed()) {
        try { cmcWindow.destroy(); } catch { /* ignore */ }
    }
    cmcWindow = null;
    try {
        const ses = session.fromPartition(CMC_PARTITION);
        await ses.clearStorageData(); // cookie + localStorage + IndexedDB...
        try { await ses.clearCache(); } catch { /* ignore */ }
    } catch { /* ignore */ }
    return true;
}

/**
 * Xoá SẠCH mọi phiên đăng nhập (portal CMC + Gemini): đóng cửa sổ + xoá cookie/cache của cả 2 partition.
 * Dùng khi "Xoá toàn bộ dữ liệu" -> app trở về trạng thái như mới cài (chưa đăng nhập gì).
 */
async function clearAllSessions() {
    closeAll();
    clearOutlookToken();
    for (const part of [CMC_PARTITION, GEMINI_PARTITION]) {
        try {
            const ses = session.fromPartition(part);
            await ses.clearStorageData();
            try { await ses.clearCache(); } catch { /* ignore */ }
        } catch { /* ignore */ }
    }
    return true;
}

module.exports = {
    openCmc,
    getCmc,
    isCmcOpen,
    navigateCmc,
    navigateCmcWait,
    ensurePortalAuth,
    invalidatePortalAuth,
    captureCmc,
    deepCaptureCmc,
    captureRoutesApi,
    fetchJsonInPortal,
    captureApiPages,
    hideCmc,
    showCmc,
    closeCmc,
    clearNetworkData,
    readCmcCookies,
    connectGemini,
    autoLoadGeminiCookies,
    openOutlookCompose,
    closeAll,
    logoutCmc,
    clearAllSessions,
    CMC_PARTITION,
    GEMINI_PARTITION,
};
