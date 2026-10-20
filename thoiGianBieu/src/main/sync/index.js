"use strict";

/**
 * Điều phối đồng bộ dữ liệu từ portal CMC.
 *
 * ĐĂNG NHẬP MỘT LẦN cho cả 4 portal:
 *   - login(): mở 1 cửa sổ, sinh viên đăng nhập Microsoft SSO một lần.
 *   - openPortal(key): điều hướng CHÍNH cửa sổ đó sang portal khác — vì dùng chung
 *     session nên không phải đăng nhập lại.
 *   - capture(key, kind): chụp nội dung trang hiện tại, AI bóc tách -> lưu cục bộ.
 *
 * Session được lưu (persist) nên lần sau mở app vẫn còn đăng nhập.
 */

const fs = require("fs");
const path = require("path");
const store = require("../store");
const ai = require("../ai");
const browserLogin = require("./browserLogin");
const iuParser = require("./iuParser");
const apiParsers = require("./apiParsers");

// Hiện chỉ bật IU. Bắt API theo route (không scan DOM). #hoso để định danh tài khoản (MSSV).
//  - IU: hồ sơ (#hoso) + thời khóa biểu (#lichhoc) + lịch thi (#lichthi) + điểm (#diemhoc).
//  - eLearning/LMS/EduX: tạm bỏ qua theo yêu cầu (bật lại sau).
const PORTALS = {
    iu: {
        key: "iu",
        name: "IU - Cổng đào tạo",
        url: "https://iu.cmcu.edu.vn/congthongtin/Index.aspx",
        enabled: true,
        apiOnly: true,
        parser: "iu", // map thẳng field (không cần AI)
        scope: ["profile", "courses", "exams", "grades", "tuition"],
        // Các bản IU/APIS từng dùng nhiều alias khác nhau cho cùng màn hình.
        routes: ["#hoso", "#lichhoc", "#thoikhoabieu", "#tkb", "#lichthi", "#diemhoc"],
    },
    // Thứ tự cào (theo yêu cầu): iu -> edux -> elearning -> lms. Đăng nhập Microsoft MỘT LẦN,
    // sau đó vòng lặp vào từng web bằng SSO (dùng chung phiên), gọi thẳng REST API rồi map (không AI).
    // API endpoint xác định từ req/res THẬT đã bắt được:
    //   - EduX (SPA): /api/subjects/joined -> danh sách môn (materials).
    //   - eLearning (SPA, api ở api.elearning.cmcu.edu.vn): Courses/enrolled+dashboard -> khóa (materials).
    //   - LMS (Canvas): /api/v1/planner/items + todo -> BÀI TẬP (assignments).
    edux: { key: "edux", name: "EduX", url: "https://edux.cmcu.edu.vn/", enabled: true, api: true, parser: "edux", apiEndpoints: ["/api/subjects/joined"], apiPages: ["/"], scope: ["assignments", "materials"] },
    elearning: { key: "elearning", name: "eLearning", url: "https://elearning.cmcu.edu.vn/", enabled: true, api: true, parser: "elearning", apiPages: ["/my-assignment", "/dashboard"], scope: ["assignments", "materials"] },
    lms: {
        key: "lms", name: "LMS (Canvas)", url: "https://lms.cmcu.edu.vn/", enabled: true, api: true, parser: "lms", scope: ["assignments"],
        apiEndpoints: () => {
            const start = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
            return [`/api/v1/planner/items?per_page=50&start_date=${start}`, "/api/v1/users/self/todo?per_page=50"];
        },
    },
};
const ENABLED_PORTALS = Object.keys(PORTALS).filter((k) => PORTALS[k].enabled !== false);
// Chỉ cần AI (Gemini) nếu có portal bật KHÔNG có parser trực tiếp.
function needsAI() {
    return ENABLED_PORTALS.some((k) => !PORTALS[k].parser);
}

// Đăng nhập bằng tài khoản Microsoft của trường (KHÔNG mở trang login riêng của 4 portal).
// office.com cho màn đăng nhập Microsoft và landing ổn định để nhận biết đã đăng nhập.
// Sau khi có phiên Microsoft, app tự bấm "Sign in using Microsoft" trên từng portal để SSO vào.
const MS_LOGIN_URL = "https://www.office.com/";

let progressSender = () => { };
function setProgressSender(fn) {
    progressSender = typeof fn === "function" ? fn : () => { };
}

let sawMsLogin = false; // đã đi qua trang đăng nhập Microsoft chưa
let hasAutoCrawled = false; // đã tự động cào sau lần đăng nhập này chưa
let crawlInProgress = false; // đang cào

function hostOf(url) {
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return "";
    }
}
// Trang đăng nhập của Microsoft / IdP.
function isMsLoginHost(host) {
    return /microsoftonline\.com$|login\.live\.com$|login\.microsoft\.com$|aadcdn\.|\.sts\.|okta|adfs/i.test(host);
}
// Trang đã đăng nhập thành công của Microsoft 365.
function isSignedInHost(host) {
    return /(^|\.)office\.com$|(^|\.)office365\.com$|(^|\.)microsoft365\.com$|(^|\.)cloud\.microsoft$|(^|\.)outlook\.office\.com$|(^|\.)my(applications|apps)\.microsoft\.com$|(^|\.)portal\.office\.com$/i.test(host);
}
function isCmcHost(host) {
    return /cmcu\.edu\.vn$/i.test(host);
}
// Vẫn đang ở trang đăng nhập (kiểm tra cả path, ví dụ login.aspx của IU).
function looksLikeLogin(url) {
    return /login|signin|sign-in|microsoftonline|adfs|\.sts\.|okta/i.test(String(url || ""));
}

// Xử lý điều hướng của cửa sổ để phát hiện đăng nhập Microsoft xong.
// ĐỒNG BỘ THỤ ĐỘNG: chỉ HIỆN cửa sổ khi CẦN người dùng đăng nhập; đăng nhập xong thì tự ẩn & cào ngầm.
function onNavigate(url) {
    const host = hostOf(url);
    if (!host) return;
    if (crawlInProgress) return; // đang cào ngầm: SSO/điều hướng do crawler tự lo, bỏ qua

    // Đang ở trang đăng nhập (Microsoft hoặc login.aspx của portal) -> cần thao tác của người dùng.
    if (isMsLoginHost(host) || (isCmcHost(host) && looksLikeLogin(url))) {
        sawMsLogin = true;
        browserLogin.showCmc(); // hiện cửa sổ để chọn tài khoản / đăng nhập
        progressSender({ type: "cmc", stage: "logging-in", url });
        return;
    }
    // Đã rời khỏi trang đăng nhập và tới một trang hợp lệ -> coi như đã đăng nhập.
    if (isSignedInHost(host) || (isCmcHost(host) && !looksLikeLogin(url)) || sawMsLogin) {
        const s = store.getSettings();
        if (!s.portal || !s.portal.loggedIn) {
            store.setSettings({ portal: { loggedIn: true, loginAt: Date.now() } });
        }
        progressSender({ type: "cmc", stage: "logged-in", url });
        // Đăng nhập xong -> tự ẩn cửa sổ và cào ngầm nhanh nhất, không cần bấm nút.
        maybeAutoCrawl();
    }
}

function login() {
    sawMsLogin = false;
    hasAutoCrawled = false;
    browserLogin.openCmc(MS_LOGIN_URL, { onNavigate });
    return { ok: true, opened: true };
}

// Tự động cào sau khi đăng nhập (một lần cho mỗi phiên đăng nhập). Tự bảo vệ chống gọi trùng.
function maybeAutoCrawl() {
    if (hasAutoCrawled || crawlInProgress) return;
    if (!browserLogin.isCmcOpen()) return;
    if (needsAI() && !ai.status().ready) {
        progressSender({ type: "crawl", stage: "need-ai", message: "Trợ lý AI chưa sẵn sàng nên chưa thể tự phân tích. Hãy kiểm tra tại Cài đặt." });
        return;
    }
    hasAutoCrawled = true;
    browserLogin.hideCmc(); // đồng bộ thụ động: ẩn trình duyệt, cào ngầm
    setTimeout(() => {
        crawlAll().catch((e) => {
            hasAutoCrawled = false; // cho phép thử lại nếu lỗi
            progressSender({ type: "crawl", stage: "error", message: (e && e.message) || String(e) });
        });
    }, 500);
}

/**
 * Điểm khởi động tự động (không cần nút): đảm bảo cửa sổ đăng nhập mở.
 * - Chưa từng đăng nhập -> mở trang đăng nhập Microsoft.
 * - Đã đăng nhập trước đó (session còn) -> mở thẳng portal để SSO vào rồi tự cào.
 */
function autoStart() {
    if (browserLogin.isCmcOpen()) {
        maybeAutoCrawl();
        return { opened: false, crawling: crawlInProgress };
    }
    // Đã cào trong phiên này rồi thì không tự mở lại cửa sổ (tránh phiền).
    if (hasAutoCrawled || crawlInProgress) return { opened: false, done: true };
    const wasLoggedIn = !!(store.getSettings().portal || {}).loggedIn;
    sawMsLogin = false;
    // ĐỒNG BỘ THỤ ĐỘNG:
    //  - Đã đăng nhập từ trước -> mở ẨN portal, tự SSO & cào ngầm (không hiện trình duyệt).
    //  - Chưa đăng nhập -> mở trang đăng nhập Microsoft (HIỆN) để chọn tài khoản; xong sẽ tự ẩn.
    browserLogin.openCmc(wasLoggedIn ? PORTALS.iu.url : MS_LOGIN_URL, { onNavigate, hidden: wasLoggedIn });
    return { opened: true, wasLoggedIn, hidden: wasLoggedIn };
}

function openPortal(portalKey) {
    const p = PORTALS[portalKey];
    if (!p) throw new Error("Portal không hợp lệ: " + portalKey);
    if (browserLogin.isCmcOpen()) browserLogin.navigateCmc(p.url);
    else browserLogin.openCmc(p.url, { onNavigate });
    return { ok: true, portal: portalKey };
}

async function capture(portalKey, kind) {
    const p = PORTALS[portalKey];
    if (!p) throw new Error("Portal không hợp lệ: " + portalKey);
    if (!["timetable", "assignments", "exams"].includes(kind)) throw new Error("Loại dữ liệu không hợp lệ: " + kind);

    const captured = await browserLogin.captureCmc();

    if (looksLikeLogin(captured.url)) {
        return { ok: false, reason: "LOGIN_REQUIRED", message: "Có vẻ đang ở trang đăng nhập. Hãy đăng nhập Microsoft rồi mở đúng trang dữ liệu." };
    }

    const status = ai.status();
    if (!status.ready) {
        return { ok: false, reason: "AI_NOT_READY", message: "Trợ lý AI chưa sẵn sàng. Hãy kiểm tra tại Cài đặt." };
    }

    const { collection, items } = await ai.parseScraped(kind, captured);
    const source = `portal:${portalKey}`;
    const count = store.replaceBySource(collection, source, items);
    store.setSettings({ portal: { lastSync: Date.now() } });

    return { ok: true, portal: portalKey, kind, collection, count, sample: items.slice(0, 5) };
}

function cleanProfile(p) {
    if (!p || typeof p !== "object") return {};
    const out = {};
    for (const k of ["name", "mssv", "dob", "gender", "class", "cohort", "major", "faculty", "email", "phone", "address"]) {
        if (typeof p[k] === "string" && p[k].trim()) out[k] = p[k].trim();
    }
    for (const k of ["cpa", "gpa", "creditsEarned", "creditsTotal"]) {
        if (typeof p[k] === "number" && !isNaN(p[k])) out[k] = p[k];
    }
    return out;
}

// Từ khóa ưu tiên khi đi link, để tới đúng trang chứa dữ liệu cần cào.
const SCOPE_KEYWORDS = {
    profile: ["hoso", "ho-so", "thongtin", "thong-tin", "sinhvien", "sinh-vien", "profile", "canhan", "ca-nhan", "info"],
    courses: ["lich", "thoikhoa", "tkb", "hoc", "schedule", "calendar", "lop", "monhoc"],
    exams: ["thi", "lichthi", "exam"],
    assignments: ["baitap", "bai-tap", "assignment", "nop", "quiz", "homework", "deadline", "course", "khoahoc", "hocphan", "grade", "my"],
    announcements: ["thongbao", "thong-bao", "tin", "news", "announce", "notification"],
    materials: ["tailieu", "tai-lieu", "hoclieu", "material", "resource", "baigiang", "file", "document", "noidung", "content"],
};

// Lưu bản chụp thô của mỗi lần cào (để soi lỗi khi dữ liệu chưa chuẩn): <userData>/debug/last-<portal>.json
function writeDebug(portalKey, captured, stats) {
    try {
        const dir = path.join(store.getDataDir() || ".", "debug");
        fs.mkdirSync(dir, { recursive: true });
        const slim = {
            when: new Date().toISOString(),
            portal: portalKey,
            stats,
            decrypted: (captured.decrypted || []).slice(0, 80).map((s) => String(s).slice(0, 40000)),
            api: (captured.api || []).slice(0, 60).map((r) => ({ url: r.url, len: (r.body || "").length, decoded: (r.decoded || []).length })),
            pages: (captured.pages || []).map((p) => ({ url: p.url, title: p.title, tables: (p.tables || []).length, textLen: (p.text || "").length })),
        };
        fs.writeFileSync(path.join(dir, `last-${portalKey}.json`), JSON.stringify(slim, null, 2), "utf8");
    } catch {
        /* ignore */
    }
}

// Lưu bản chụp API (portal SPA) để soi khi cần.
function writeDebugApi(portalKey, results) {
    try {
        const dir = path.join(store.getDataDir() || ".", "debug");
        fs.mkdirSync(dir, { recursive: true });
        const slim = {
            when: new Date().toISOString(),
            portal: portalKey,
            results: (results || []).map((r) => ({ url: r.url, status: r.status, len: (r.body || "").length, body: String(r.body || "").slice(0, 40000) })),
        };
        fs.writeFileSync(path.join(dir, `last-${portalKey}.json`), JSON.stringify(slim, null, 2), "utf8");
    } catch {
        /* ignore */
    }
}

function responseArray(result) {
    try {
        const body = JSON.parse((result && result.body) || "null");
        if (Array.isArray(body)) return body;
        if (body && Array.isArray(body.data)) return body.data;
        if (body && body.data && Array.isArray(body.data.items)) return body.data.items;
    } catch {
        /* ignore */
    }
    return [];
}

// EduX không có một endpoint "tất cả bài tập". Cần đi từ học phần -> trợ giảng
// -> cấu hình bài kiểm tra/bài tập để lấy đúng tiêu đề và deadline.
async function fetchEduxDetails(results) {
    const joinedResult = (results || []).find((r) =>
        /\/subjects\/joined/i.test((r && r.url) || "") && responseArray(r).length
    );
    const subjects = responseArray(joinedResult).filter((s) => s && s.id).slice(0, 40);
    if (!subjects.length) return [];

    let apiBase = "";
    try {
        apiBase = String(joinedResult.url).replace(/\/subjects\/joined(?:[?#].*)?$/i, "");
    } catch {
        apiBase = "";
    }
    if (!apiBase) apiBase = "https://api-edux.cmcu.edu.vn/api";

    const modelUrls = subjects.map((s) => `${apiBase}/subjects/${encodeURIComponent(s.id)}/models`);
    const modelResults = await browserLogin.fetchJsonInPortal(modelUrls);
    const models = [];
    for (const result of modelResults) {
        for (const model of responseArray(result)) {
            if (model && model.id && (model.exist_exam || model.exist_manual_exercise)) models.push(model);
        }
    }

    const detailUrls = [];
    for (const model of models.slice(0, 120)) {
        const id = encodeURIComponent(model.id);
        if (model.exist_exam) detailUrls.push(`${apiBase}/exam/config/${id}`);
        if (model.exist_manual_exercise) {
            detailUrls.push(`${apiBase}/manual-exercises/configs?model_id=${id}`);
            detailUrls.push(`${apiBase}/manual-exercises/models/${id}/submission`);
        }
    }
    const details = detailUrls.length ? await browserLogin.fetchJsonInPortal(detailUrls) : [];
    return [...modelResults, ...details];
}

// Cào portal SPA bằng REST API trực tiếp: gọi các endpoint đã biết -> parser map -> lưu.
async function crawlPortalApi(p, authRetry = false) {
    progressSender({ type: "crawl", portal: p.key, stage: "crawling", name: p.name });
    const eps = typeof p.apiEndpoints === "function" ? p.apiEndpoints() : (p.apiEndpoints || []);
    let results = [];
    if (eps.length) results.push(...await browserLogin.fetchJsonInPortal(eps));
    if (p.apiPages && p.apiPages.length) {
        results.push(...await browserLogin.captureApiPages(p.apiPages, { waitMs: 5500 }));
    }
    if (p.key === "edux") {
        results.push(...await fetchEduxDetails(results));
    }
    writeDebugApi(p.key, results);

    const unauthorized = results.some((r) => {
        if (Number(r && r.status) === 401 || Number(r && r.status) === 403) return true;
        try {
            const body = JSON.parse((r && r.body) || "{}");
            return Number(body.status) === 401 || Number(body.status) === 403;
        } catch {
            return false;
        }
    });
    if (unauthorized) {
        await browserLogin.invalidatePortalAuth(p.key);
        if (!authRetry && await browserLogin.ensurePortalAuth(p.key)) {
            return crawlPortalApi(p, true);
        }
        browserLogin.showCmc();
        const message = `${p.name} chưa hoàn tất đăng nhập Microsoft (API trả 401).`;
        progressSender({ type: "crawl", portal: p.key, stage: "error", name: p.name, message });
        return { ok: false, reason: "LOGIN_REQUIRED", message };
    }

    progressSender({ type: "crawl", portal: p.key, stage: "analyzing", name: p.name });
    let data = null;
    try { data = apiParsers.parseApi(p.parser, results); } catch { data = null; }
    if (!data) {
        progressSender({ type: "crawl", portal: p.key, stage: "error", name: p.name, message: "Không đọc được API." });
        return { ok: false, reason: "PARSE", message: "Không đọc được API của " + p.key };
    }

    const source = `portal:${p.key}`;
    const counts = {};
    let extracted = 0;
    for (const col of p.scope || []) {
        if (Array.isArray(data[col]) && data[col].length) { counts[col] = store.replaceBySource(col, source, data[col]); extracted += counts[col]; }
        else counts[col] = 0;
    }
    store.setSettings({ portal: { loggedIn: true, lastSync: Date.now() } });
    progressSender({ type: "crawl", portal: p.key, stage: "done", name: p.name, counts });
    return { ok: true, portal: p.key, counts, extracted };
}

// Cào một portal theo ĐÚNG phạm vi (scope) đã định -> đi qua nhiều trang + bắt JSON API -> AI bóc tách -> lưu cục bộ.
// Có TỰ THỬ LẠI khi chưa trích được mục nào (chờ lâu hơn), và lưu bản chụp để soi lỗi.
async function crawlPortal(portalKey) {
    const p = PORTALS[portalKey];
    if (!p) throw new Error("Portal không hợp lệ: " + portalKey);
    if (!browserLogin.isCmcOpen()) {
        return { ok: false, reason: "LOGIN_REQUIRED", message: "Chưa đăng nhập. Bấm \"Đăng nhập bằng Microsoft\" trước." };
    }
    // IU dùng parser trực tiếp (không cần AI). Chỉ portal dùng AI mới cần Gemini.
    if (!p.parser && !ai.status().ready) {
        return { ok: false, reason: "AI_NOT_READY", message: "Trợ lý AI chưa sẵn sàng. Hãy kiểm tra tại Cài đặt." };
    }

    progressSender({ type: "crawl", portal: portalKey, stage: "opening", name: p.name });
    await browserLogin.navigateCmcWait(p.url);

    // Tự đăng nhập vào portal qua SSO Microsoft (bấm "Sign in using Microsoft" nếu cần).
    progressSender({ type: "crawl", portal: portalKey, stage: "authing", name: p.name });
    const authed = await browserLogin.ensurePortalAuth(p.key);
    if (!authed) {
        browserLogin.showCmc(); // phiên hết hạn -> hiện cửa sổ để đăng nhập lại
        progressSender({ type: "crawl", portal: portalKey, stage: "error", name: p.name, message: "Phiên hết hạn — đã mở cửa sổ để đăng nhập lại." });
        return { ok: false, reason: "LOGIN_REQUIRED", message: `Phiên đăng nhập hết hạn. Đã mở cửa sổ — hãy đăng nhập Microsoft rồi thử lại.` };
    }

    // Portal SPA có REST API rõ ràng (LMS/EduX/eLearning): gọi thẳng API rồi map (không DOM, không AI).
    if (p.api) return await crawlPortalApi(p);

    const scope = p.scope || ["courses", "exams", "assignments", "announcements", "materials"];
    const prefer = [].concat(...scope.map((s) => SCOPE_KEYWORDS[s] || []));
    const seedHashes = scope.includes("profile") ? ["#hoso"] : [];

    const maxAttempts = 2;
    let captured = null;
    let data = null;
    let counts = null;
    let stats = null;
    let lastErr = null;
    let switched = false;
    let extracted = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        progressSender({ type: "crawl", portal: portalKey, stage: "crawling", name: p.name, attempt });
        const onCap = (pr) => progressSender({ type: "crawl", portal: portalKey, stage: "crawling", name: p.name, ...pr });
        if (p.apiOnly) {
            // BẮT API theo route (không scan DOM) -> nhẹ, chính xác.
            captured = await browserLogin.captureRoutesApi(p.routes, { waitMs: attempt === 1 ? 3200 : 4800, onProgress: onCap });
        } else {
            captured = await browserLogin.deepCaptureCmc({ maxPages: 8, prefer, seedHashes, waitMs: attempt === 1 ? 2600 : 4200, onProgress: onCap });
        }
        stats = { pages: (captured.pages || []).length, api: (captured.api || []).length, decrypted: (captured.decrypted || []).length };
        writeDebug(portalKey, captured, stats);

        const curUrl = captured.url || (captured.pages && captured.pages[0] && captured.pages[0].url) || "";
        const onLogin = looksLikeLogin(curUrl) || ((captured.pages || []).length > 0 && captured.pages.every((pg) => looksLikeLogin(pg.url)));
        if (onLogin) {
            return { ok: false, reason: "LOGIN_REQUIRED", message: "Có vẻ chưa đăng nhập. Đăng nhập Microsoft rồi thử lại.", stats };
        }

        progressSender({ type: "crawl", portal: portalKey, stage: "analyzing", name: p.name, attempt });
        try {
            if (p.parser === "iu") data = iuParser.parseIu(captured.decrypted || []);
            else data = await ai.parseFullPortal(portalKey, captured, scope);
        } catch (e) {
            lastErr = e;
            data = null;
        }

        if (data) {
            // Hồ sơ (IU): xác định đúng sinh viên theo MSSV -> chuyển folder TRƯỚC khi lưu.
            if (scope.includes("profile") && !switched) {
                const prof = cleanProfile(data.profile);
                if (prof.email || prof.mssv) {
                    const key = store.ensureStudentByProfile(prof);
                    store.setActiveStudent(key);
                    switched = true;
                    progressSender({ type: "crawl", portal: portalKey, stage: "account", name: p.name, mssv: prof.mssv || "", email: prof.email || "" });
                }
                if (Object.keys(prof).length) store.setSettings({ student: prof });
            }
            const source = `portal:${portalKey}`;
            counts = {};
            extracted = 0;
            for (const col of scope) {
                if (col === "profile") continue;
                // Chỉ ghi đè khi có dữ liệu, tránh xoá nhầm dữ liệu cũ nếu lần cào này không đầy đủ.
                if (Array.isArray(data[col]) && data[col].length) { counts[col] = store.replaceBySource(col, source, data[col]); extracted += counts[col]; }
                else counts[col] = 0;
            }
            const gotProfile = scope.includes("profile") && switched;
            if (extracted > 0 || gotProfile) break; // đã có dữ liệu -> dừng
        }

        if (attempt < maxAttempts) {
            progressSender({ type: "crawl", portal: portalKey, stage: "retry", name: p.name });
            try { await browserLogin.navigateCmcWait(p.url); await browserLogin.ensurePortalAuth(p.key); } catch { /* ignore */ }
        }
    }

    if (!data) {
        progressSender({ type: "crawl", portal: portalKey, stage: "error", name: p.name, message: "AI chưa đọc được dữ liệu.", stats });
        return { ok: false, reason: "PARSE", message: "AI chưa đọc được dữ liệu" + (lastErr ? ": " + lastErr.message : "") + ".", stats };
    }

    store.setSettings({ portal: { loggedIn: true, lastSync: Date.now() } });
    progressSender({ type: "crawl", portal: portalKey, stage: "done", name: p.name, counts, stats });
    return { ok: true, portal: portalKey, counts, stats, extracted };
}

// Cào lần lượt cả 4 portal rồi gom về một chỗ.
async function crawlAll() {
    if (crawlInProgress) return { ok: false, reason: "BUSY", message: "Đang cào dữ liệu, vui lòng đợi." };
    if (!browserLogin.isCmcOpen()) {
        return { ok: false, reason: "LOGIN_REQUIRED", message: "Chưa đăng nhập." };
    }
    if (needsAI() && !ai.status().ready) {
        return { ok: false, reason: "AI_NOT_READY", message: "Trợ lý AI chưa sẵn sàng. Hãy kiểm tra tại Cài đặt." };
    }
    crawlInProgress = true;
    progressSender({ type: "crawl", stage: "all-start" });
    const results = {};
    try {
        for (const key of ENABLED_PORTALS) {
            try {
                results[key] = await crawlPortal(key);
                // Giữ nguyên cửa sổ tại đúng portal cần đăng nhập. Nếu tiếp tục
                // điều hướng sang portal kế tiếp, người dùng không thể hoàn tất SSO.
                if (results[key] && results[key].reason === "LOGIN_REQUIRED") break;
            } catch (e) {
                results[key] = { ok: false, error: (e && e.message) || String(e) };
                progressSender({ type: "crawl", portal: key, stage: "error", message: results[key].error });
            }
        }
    } finally {
        crawlInProgress = false;
    }
    let totalExtracted = 0;
    for (const r of Object.values(results)) if (r && r.ok) totalExtracted += r.extracted || 0;
    const needLogin = Object.values(results).some((r) => r && r.reason === "LOGIN_REQUIRED");
    // Chưa lấy được gì hoặc còn portal chưa đăng nhập -> cho phép tự cào tiếp
    // ngay khi người dùng hoàn tất SSO.
    if (totalExtracted === 0 || needLogin) hasAutoCrawled = false;
    // Đồng bộ thụ động: cào xong -> ĐÓNG trình duyệt (giữ phiên đăng nhập),
    // trừ khi có portal đòi đăng nhập lại (khi đó cửa sổ đã được hiện để người dùng đăng nhập).
    if (!needLogin) browserLogin.closeCmc();
    progressSender({ type: "crawl", stage: "all-done", totalExtracted });
    return { ok: true, results, totalExtracted, lastSync: Date.now() };
}

function status() {
    const s = store.getSettings();
    return {
        portals: ENABLED_PORTALS.map((k) => ({ key: PORTALS[k].key, name: PORTALS[k].name, url: PORTALS[k].url, scope: PORTALS[k].scope })),
        loggedIn: !!(s.portal && s.portal.loggedIn),
        loginAt: (s.portal && s.portal.loginAt) || 0,
        cmcOpen: browserLogin.isCmcOpen(),
        lastSync: (s.portal && s.portal.lastSync) || 0,
    };
}

/**
 * ĐỒNG BỘ LẠI thủ công (nút "Đồng bộ lại"): cào lại dữ liệu mới nhất từ portal.
 * - Đang cào dở -> báo bận.
 * - Cửa sổ đã mở (còn phiên đăng nhập) -> ẩn đi và cào lại ngầm ngay.
 * - Cửa sổ chưa mở -> mở lại phiên (đăng nhập nếu cần) rồi tự cào (autoStart).
 * Hàm trả về NGAY; tiến trình chi tiết đẩy qua sync:progress.
 */
async function resync() {
    if (crawlInProgress) return { ok: false, reason: "BUSY", message: "Đang đồng bộ, vui lòng đợi." };
    hasAutoCrawled = false; // cho phép cào lại
    if (!browserLogin.isCmcOpen()) {
        return autoStart(); // chưa mở -> mở lại (ẩn nếu đã đăng nhập) + tự cào
    }
    browserLogin.hideCmc(); // đồng bộ thụ động: cào ngầm, không hiện trình duyệt
    setTimeout(() => {
        crawlAll()
            .then((r) => { if (r && r.ok) hasAutoCrawled = true; })
            .catch((e) => {
                hasAutoCrawled = false;
                progressSender({ type: "crawl", stage: "error", message: (e && e.message) || String(e) });
            });
    }, 300);
    return { ok: true, started: true };
}

/**
 * Đăng xuất khỏi portal.
 * - Đóng cửa sổ + xoá phiên đăng nhập CMC (lần sau phải đăng nhập Microsoft lại).
 * - Đặt lại cờ nội bộ để phiên đồng bộ bắt đầu sạch.
 * - Ghi portal.loggedIn = false.
 * - Nếu wipe=true: xoá luôn dữ liệu học tập của sinh viên đang xem (giữ cấu hình email).
 */
async function logout({ wipe = false } = {}) {
    await browserLogin.logoutCmc();
    hasAutoCrawled = false;
    sawMsLogin = false;
    crawlInProgress = false;
    store.setSettings({ portal: { loggedIn: false, loginAt: 0, lastSync: 0 } });
    if (wipe) store.resetActiveStudent();
    progressSender({ type: "cmc", stage: "logged-out", wiped: !!wipe });
    return { ok: true, wiped: !!wipe };
}

module.exports = { PORTALS, login, openPortal, capture, crawlPortal, crawlAll, autoStart, resync, maybeAutoCrawl, status, logout, setProgressSender };
