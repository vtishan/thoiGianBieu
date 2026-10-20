"use strict";

/**
 * Gọi Gemini web (gemini.google.com) Ở CHẾ ĐỘ KHÁCH — KHÔNG cần đăng nhập, không API key,
 * không mở cửa sổ, không thao tác. App tự:
 *   1) GET /app để nhận cookie khách (NID, COMPASS) + token trang (bl = cfb2h, fsid = FdrFJe).
 *      Token "at" (SNlM0e) ở chế độ khách thường rỗng — vẫn gọi được.
 *   2) POST StreamGenerate với cookie + bl + fsid + at(rỗng) -> nhận câu trả lời.
 *
 * Nếu người dùng CÓ nạp cookie đăng nhập (tuỳ chọn) thì dùng luôn để có tài khoản riêng,
 * nhưng KHÔNG bắt buộc. Chế độ khách luôn sẵn sàng.
 *
 * Lưu ý: đây là truy cập giao diện web của Google, có thể vi phạm ToS và đôi lúc đổi endpoint.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");

const HOST = "https://gemini.google.com";
const INIT_URL = `${HOST}/app`;
const GENERATE_URL = `${HOST}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45 * 1000;
// Google occasionally returns response headers larger than Node's 16 KiB default
// (notably Set-Cookie on /app). Without this, valid sessions fail with
// HPE_HEADER_OVERFLOW before Axios can inspect the response.
const MAX_RESPONSE_HEADER_SIZE = 1024 * 1024;
// Axios/follow-redirects does not forward maxHeaderSize from its config in the
// bundled version. A tiny transport ensures Node's parser actually receives it.
const largeHeaderTransport = {
    request(options, callback) {
        return https.request({ ...options, maxHeaderSize: MAX_RESPONSE_HEADER_SIZE }, callback);
    },
};

const WANTED_COOKIES = [
    "__Secure-1PAPISID", "__Secure-3PAPISID",
    "__Secure-1PSIDCC", "__Secure-3PSIDCC",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS",
    "__Secure-1PSID", "__Secure-3PSID",
    "SAPISID", "APISID", "SIDCC", "HSID", "SSID", "SID", "NID", "COMPASS",
];

class CookieError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "CookieError";
        this.code = code || "GEMINI_ERROR";
    }
}

let dataDir = null;
let jar = {}; // cookie jar (khách + tuỳ chọn đăng nhập)
let pageToken = null; // { at, bl, fsid, fetchedAt }
// Giữ NGUYÊN cuộc trò chuyện của Gemini theo từng "kênh" (vd "assistant") để chat tiếp trong cùng
// một hội thoại (như giữ nguyên link gemini.google.com/app/<id>). Nhờ đó không phải gửi lại toàn bộ
// lịch sử mỗi lượt -> đỡ tốn token, và Gemini tự nhớ ngữ cảnh.
let conversations = {}; // { [key]: { cid, rid, rcid } }

function getConversation(key) {
    if (!key) return null;
    if (!conversations[key]) conversations[key] = { cid: "", rid: "", rcid: "" };
    return conversations[key];
}
function resetConversation(key) {
    if (key && conversations[key]) delete conversations[key];
    return true;
}

function setDataDir(dir) {
    dataDir = dir;
    loadAuthCookies();
}
function sessionFile() {
    return path.join(dataDir || ".", "gemini", "session.json");
}
function loadAuthCookies() {
    try {
        const parsed = JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
        if (parsed && parsed.cookies && typeof parsed.cookies === "object") jar = { ...jar, ...parsed.cookies };
    } catch {
        /* chưa có -> chạy chế độ khách */
    }
}
function persistAuthCookies() {
    if (!dataDir) return;
    try {
        fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
        fs.writeFileSync(sessionFile(), JSON.stringify({ cookies: jar, updatedAt: Date.now() }, null, 2), "utf8");
    } catch {
        /* ignore */
    }
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseCookieString(str) {
    const out = {};
    for (const part of String(str || "").split(/;\s*/)) {
        const eq = part.indexOf("=");
        if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
}
// Bóc cookie từ chuỗi dán trong DevTools (tuỳ chọn, khi muốn dùng tài khoản riêng).
function parseCookieDump(text) {
    const raw = String(text || "");
    const cookies = {};
    const wanted = new Set(WANTED_COOKIES);
    for (const line of raw.split(/\r?\n/)) {
        if (line.indexOf("\t") === -1) continue;
        const cols = line.split("\t");
        const name = (cols[0] || "").trim();
        const value = (cols[1] || "").trim();
        if (name && value && wanted.has(name) && !cookies[name]) cookies[name] = value;
    }
    if (!cookies["__Secure-1PSID"] && raw.includes("=")) Object.assign(cookies, parseCookieString(raw));
    return cookies;
}

function buildCookieHeader() {
    return Object.entries(jar)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
}

function absorbSetCookie(setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const line of list) {
        const first = String(line || "").split(";")[0];
        const eq = first.indexOf("=");
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (name && value) jar[name] = value;
    }
}

function commonHeaders() {
    return {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        Origin: HOST,
        Referer: `${HOST}/`,
        "X-Same-Domain": "1",
        Cookie: buildCookieHeader(),
    };
}

// Nạp cookie đăng nhập (tuỳ chọn) từ chuỗi dán hoặc map (Electron tự trích).
function setCookies(input) {
    const cookies = typeof input === "string" ? parseCookieDump(input) : { ...(input || {}) };
    jar = { ...jar, ...cookies };
    pageToken = null;
    persistAuthCookies();
    return { count: Object.keys(jar).length, hasRequired: !!jar["__Secure-1PSID"] };
}

// Chế độ khách luôn dùng được -> AI luôn sẵn sàng, không cần đăng nhập.
function isConfigured() {
    return true;
}
function isAuthenticated() {
    return !!jar["__Secure-1PSID"];
}

async function ensureSession(force = false) {
    if (!force && pageToken && Date.now() - pageToken.fetchedAt < TOKEN_TTL_MS) return pageToken;

    let response;
    try {
        response = await axios.get(INIT_URL, {
            timeout: REQUEST_TIMEOUT_MS,
            transport: largeHeaderTransport,
            responseType: "text",
            transformResponse: [(d) => d],
            maxRedirects: 5,
            validateStatus: (s) => s >= 200 && s < 400,
            headers: commonHeaders(),
        });
    } catch (error) {
        throw new CookieError(`Không mở được dịch vụ AI: ${error && error.message}`, "GEMINI_NETWORK");
    }
    absorbSetCookie(response.headers && response.headers["set-cookie"]);

    const html = String(response.data || "");
    const at = (html.match(/"SNlM0e":"(.*?)"/) || [])[1] || "";
    const bl = (html.match(/"cfb2h":"(.*?)"/) || [])[1] || "";
    const fsid = (html.match(/"FdrFJe":"(.*?)"/) || [])[1] || "";
    pageToken = { at, bl: bl || "boq_assistant-bard-web-server", fsid, fetchedAt: Date.now() };
    return pageToken;
}

function deepFindText(node, depth = 0) {
    if (depth > 8 || node == null) return "";
    if (typeof node === "string") return node;
    if (!Array.isArray(node)) return "";
    let best = "";
    for (const child of node) {
        const found = deepFindText(child, depth + 1);
        if (found && found.length > best.length) best = found;
    }
    return best;
}

function parseGenerateResponse(rawText) {
    const text = String(rawText || "");
    let best = "";
    const ids = { cid: "", rid: "", rcid: "" };
    let sawPayload = false;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("[")) continue;
        let arr;
        try {
            arr = JSON.parse(trimmed);
        } catch {
            continue;
        }
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
            if (!(Array.isArray(item) && item[0] === "wrb.fr" && typeof item[2] === "string")) continue;
            let payload;
            try {
                payload = JSON.parse(item[2]);
            } catch {
                continue;
            }
            if (!payload) continue;
            sawPayload = true;
            // Metadata cuộc trò chuyện: payload[1] = [conversationId, responseId].
            if (Array.isArray(payload[1])) {
                if (payload[1][0]) ids.cid = payload[1][0];
                if (payload[1][1]) ids.rid = payload[1][1];
            }
            const candidates = (Array.isArray(payload[4]) && payload[4]) || (Array.isArray(payload[3]) && payload[3]) || null;
            const first = candidates ? candidates[0] : null;
            let answer = "";
            if (first) {
                if (first[0]) ids.rcid = first[0]; // choiceId -> để tiếp tục đúng nhánh trả lời
                answer = (Array.isArray(first[1]) ? first[1][0] : first[1]) || "";
                if (!answer) answer = deepFindText(first);
            }
            if (answer && answer.length >= best.length) best = answer;
        }
    }
    if (!sawPayload) throw new CookieError("Không phân tích được phản hồi từ dịch vụ AI.", "GEMINI_PARSE");
    if (!best) throw new CookieError("Dịch vụ AI không trả về nội dung.", "GEMINI_EMPTY");
    return { text: String(best).replace(/\r\n/g, "\n").trim(), cid: ids.cid, rid: ids.rid, rcid: ids.rcid };
}

async function askOnce(prompt, conv) {
    const token = await ensureSession(false);
    // Nối tiếp cuộc trò chuyện cũ (nếu có) bằng [conversationId, responseId, choiceId].
    const ctxIds = conv ? [conv.cid || "", conv.rid || "", conv.rcid || ""] : ["", "", ""];
    const reqPayload = [null, JSON.stringify([[String(prompt)], null, ctxIds])];
    const bodyParams = new URLSearchParams();
    bodyParams.set("f.req", JSON.stringify(reqPayload));
    bodyParams.set("at", token.at || "");

    const query = new URLSearchParams({
        bl: token.bl || "boq_assistant-bard-web-server",
        _reqid: String(Math.floor(Math.random() * 900000) + 100000),
        rt: "c",
    });
    if (token.fsid) query.set("f.sid", token.fsid);

    let response;
    try {
        response = await axios.post(`${GENERATE_URL}?${query.toString()}`, bodyParams.toString(), {
            timeout: REQUEST_TIMEOUT_MS,
            transport: largeHeaderTransport,
            responseType: "text",
            transformResponse: [(d) => d],
            validateStatus: (s) => s >= 200 && s < 500,
            headers: { ...commonHeaders(), "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        });
    } catch (error) {
        throw new CookieError(`Lỗi mạng khi gọi dịch vụ AI: ${error && error.message}`, "GEMINI_NETWORK");
    }
    absorbSetCookie(response.headers && response.headers["set-cookie"]);
    if (response.status === 401 || response.status === 403) {
        pageToken = null;
        throw new CookieError("Dịch vụ AI từ chối yêu cầu (401/403).", "GEMINI_AUTH");
    }
    const parsed = parseGenerateResponse(response.data);
    // Lưu lại ID cuộc trò chuyện để lượt sau chat tiếp trong CÙNG hội thoại.
    if (conv) {
        if (parsed.cid) conv.cid = parsed.cid;
        if (parsed.rid) conv.rid = parsed.rid;
        if (parsed.rcid) conv.rcid = parsed.rcid;
    }
    return parsed.text;
}

/**
 * Hỏi Gemini (chế độ khách mặc định).
 * - Nếu opts.conversationId: nối tiếp CÙNG một cuộc trò chuyện (giữ nguyên hội thoại Gemini),
 *   KHÔNG gửi lại lịch sử -> đỡ tốn token. Hướng dẫn hệ thống chỉ gửi ở LƯỢT ĐẦU.
 * - Nếu không: hỏi độc lập (one-shot), luôn kèm hướng dẫn hệ thống.
 * (Kênh web không có trường system riêng nên ghép vào prompt lượt đầu.)
 */
async function ask(_cfg, prompt, opts = {}) {
    const conv = opts.conversationId ? getConversation(opts.conversationId) : null;
    const firstTurn = !conv || !conv.cid; // lượt đầu của cuộc trò chuyện (hoặc one-shot)

    const buildPrompt = (withSystem) => {
        const parts = [];
        if (opts.system && withSystem) parts.push(`[Hướng dẫn hệ thống]\n${opts.system}`);
        parts.push(String(prompt || ""));
        return parts.join("\n\n");
    };

    try {
        return await askOnce(buildPrompt(firstTurn), conv);
    } catch (error) {
        // Làm mới phiên rồi thử lại một lần (giữ nguyên cuộc trò chuyện).
        pageToken = null;
        try {
            return await askOnce(buildPrompt(firstTurn), conv);
        } catch (e2) {
            // Cuộc trò chuyện có thể đã hỏng/hết hạn -> bỏ và bắt đầu cuộc mới (kèm lại hướng dẫn hệ thống).
            if (conv) {
                resetConversation(opts.conversationId);
                return await askOnce(buildPrompt(true), getConversation(opts.conversationId));
            }
            throw e2;
        }
    }
}

module.exports = { setDataDir, setCookies, isConfigured, isAuthenticated, ask, resetConversation, CookieError, _internal: { parseCookieDump } };
