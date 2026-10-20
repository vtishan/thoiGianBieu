"use strict";

/**
 * Gửi email qua SMTP (nodemailer). Dùng cho tính năng tự gửi đơn xin nghỉ tới giảng viên.
 * Với Gmail: user = email, pass = App Password (https://myaccount.google.com/apppasswords).
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const nodemailer = require("nodemailer");
const store = require("./store");

// Outlook REST v2 đã ngừng hoạt động từ 03/2024. Hộp thư dùng Microsoft Graph khi
// Outlook Web cấp token Graph cho phiên SSO hiện tại; nếu tenant không cấp quyền Graph,
// ta vẫn lấy danh sách thư trực tiếp từ phản hồi FindItem của Outlook Web.
const GRAPH_API = "https://graph.microsoft.com/v1.0";
const OUTLOOK_INBOX_URL = "https://outlook.office.com/mail/inbox";
const OUTLOOK_CACHE_MS = 60 * 1000;
const outlookCache = {
    graphToken: "",
    graphExp: 0,
    account: null,
    messages: [],
    rawMessages: new Map(),
    fetchedAt: 0,
    source: "",
};

function graphHeaders(token, extra = {}) {
    return {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...extra,
    };
}

function jwtClaims(token) {
    try {
        const part = String(token || "").split(".")[1] || "";
        const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
        return {};
    }
}

function tokenExpiresAt(token) {
    const claims = jwtClaims(token);
    return Number(claims.exp || 0) * 1000;
}

function graphTokenIsUsable() {
    return !!outlookCache.graphToken && outlookCache.graphExp - Date.now() > 2 * 60 * 1000;
}

function accountFromClaims(claims) {
    const email = claims.preferred_username || claims.upn || claims.email || claims.unique_name || "";
    const name = claims.name || "";
    if (!email && !name) return null;
    return { name, email };
}

function currentAccount() {
    const student = (store.getSettings() && store.getSettings().student) || {};
    return {
        name: (outlookCache.account && outlookCache.account.name) || student.name || "",
        email: (outlookCache.account && outlookCache.account.email) || student.email || "",
    };
}

function rememberBearer(auth, requestUrl) {
    const match = String(auth || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return;
    const token = match[1];
    const claims = jwtClaims(token);
    const account = accountFromClaims(claims);
    if (account) outlookCache.account = { ...(outlookCache.account || {}), ...account };

    const audience = String(claims.aud || "");
    const scopes = String(claims.scp || claims.roles || "");
    const isGraph = /graph\.microsoft\.com/i.test(requestUrl || "")
        || /graph\.microsoft\.com|00000003-0000-0000-c000-000000000000/i.test(audience);
    if (isGraph && /\bMail\.(Read|ReadWrite|Send)/i.test(scopes)) {
        outlookCache.graphToken = token;
        outlookCache.graphExp = tokenExpiresAt(token) || (Date.now() + 30 * 60 * 1000);
    }
}

function safeTop(value) {
    return Math.max(1, Math.min(100, Number(value) || 20));
}

function recipients(list) {
    return String(list || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((a) => ({ EmailAddress: { Address: a } }));
}

function graphRecipients(list) {
    return String(list || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean)
        .map((address) => ({ emailAddress: { address } }));
}

function htmlToText(value) {
    return String(value || "")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function mailboxParts(value) {
    const node = value || {};
    const addressNode = node.emailAddress || node.EmailAddress || node.Mailbox || node.mailbox || node;
    return {
        name: addressNode.name || addressNode.Name || "",
        address: addressNode.address || addressNode.Address || addressNode.EmailAddress || "",
    };
}

function messageId(value) {
    const id = value && (value.id || value.Id || value.ItemId || value.itemId);
    if (id && typeof id === "object") return id.id || id.Id || "";
    return typeof id === "string" ? id : "";
}

function normalizeMessage(value) {
    if (!value || typeof value !== "object") return null;
    const id = messageId(value);
    const hasMailShape = Object.prototype.hasOwnProperty.call(value, "subject")
        || Object.prototype.hasOwnProperty.call(value, "Subject");
    if (!id || !hasMailShape) return null;

    const sender = mailboxParts(value.from || value.From || value.sender || value.Sender);
    const bodyNode = value.body || value.Body || {};
    const bodyContent = bodyNode.content || bodyNode.Content || "";
    return {
        id,
        subject: value.subject || value.Subject || "(không tiêu đề)",
        from: sender.name || sender.address || "",
        fromAddress: sender.address || "",
        received: value.receivedDateTime || value.ReceivedDateTime || value.DateTimeReceived || "",
        preview: value.bodyPreview || value.BodyPreview || value.Preview || "",
        isRead: !!(value.isRead != null ? value.isRead : value.IsRead),
        hasAttachments: !!(value.hasAttachments != null ? value.hasAttachments : value.HasAttachments),
        webLink: value.webLink || value.WebLink || "",
        body: bodyContent ? (/html/i.test(bodyNode.contentType || bodyNode.ContentType || "") ? htmlToText(bodyContent) : String(bodyContent)) : "",
    };
}

function findMessagesInJson(root) {
    const found = [];
    const seenObjects = new Set();
    const visit = (value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 18 || seenObjects.has(value)) return;
        seenObjects.add(value);
        const normalized = normalizeMessage(value);
        if (normalized) found.push({ normalized, raw: value });
        if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
        } else {
            for (const child of Object.values(value)) visit(child, depth + 1);
        }
    };
    visit(root);

    const unique = new Map();
    for (const item of found) {
        const previous = unique.get(item.normalized.id);
        if (!previous || (!previous.normalized.body && item.normalized.body)) unique.set(item.normalized.id, item);
    }
    return Array.from(unique.values()).sort((a, b) =>
        new Date(b.normalized.received || 0) - new Date(a.normalized.received || 0)
    );
}

function cacheMessages(items, source) {
    const normalized = [];
    for (const item of items || []) {
        const message = item.normalized || normalizeMessage(item);
        if (!message) continue;
        normalized.push(message);
        outlookCache.rawMessages.set(message.id, item.raw || item);
    }
    outlookCache.messages = normalized;
    outlookCache.fetchedAt = Date.now();
    outlookCache.source = source || outlookCache.source || "outlook-web";
    return normalized;
}

function graphError(response, action) {
    const data = response && response.data;
    const detail = data && data.error && (data.error.message || data.error.code);
    const status = response && response.status;
    const err = new Error(`${action} (HTTP ${status || "?"})${detail ? `: ${detail}` : "."}`);
    err.code = status === 401 ? "OUTLOOK_AUTH" : status === 403 ? "OUTLOOK_PERMISSION" : "OUTLOOK_HTTP";
    return err;
}

async function graphCall(method, pathName, data, extraHeaders) {
    if (!graphTokenIsUsable()) {
        const err = new Error("Phiên Outlook chưa cấp quyền Microsoft Graph.");
        err.code = "OUTLOOK_NO_GRAPH_TOKEN";
        throw err;
    }
    const response = await axios({
        method,
        url: GRAPH_API + pathName,
        data,
        headers: graphHeaders(outlookCache.graphToken, extraHeaders),
        validateStatus: () => true,
        timeout: 25000,
    });
    if (response.status >= 400) {
        if (response.status === 401) {
            outlookCache.graphToken = "";
            outlookCache.graphExp = 0;
        }
        throw graphError(response, "Microsoft Graph từ chối yêu cầu");
    }
    return response;
}

function isLoginUrl(url) {
    return /login\.(microsoftonline|live)\.com|login\.windows\.net|\/common\/oauth2\//i.test(url || "");
}

/**
 * Mở Outlook bằng đúng partition Microsoft SSO của portal và quan sát các request.
 * Token chỉ được giữ trong RAM. Khi tenant không cho token Graph, phản hồi FindItem
 * của chính Outlook Web vẫn cung cấp danh sách thư để hiển thị.
 */
function captureOutlookSession({ partition, interactive = false, timeoutMs } = {}) {
    const { BrowserWindow } = require("electron");
    const waitMs = Number(timeoutMs) || (interactive ? 180000 : 45000);
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            width: 1080,
            height: 820,
            show: !!interactive,
            title: "Kết nối hộp thư trường",
            autoHideMenuBar: true,
            webPreferences: {
                partition,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false,
            },
        });
        const wc = win.webContents;
        const requestUrls = new Map();
        let settled = false;
        let loginTimer = null;

        const cleanup = () => {
            clearTimeout(timer);
            clearTimeout(loginTimer);
            try { wc.debugger.detach(); } catch { /* ignore */ }
            if (!win.isDestroyed()) win.destroy();
        };
        const finish = (data, err) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) reject(err);
            else resolve(data || {});
        };
        const timer = setTimeout(() => {
            const url = wc.getURL();
            const err = new Error(isLoginUrl(url)
                ? "Outlook chưa đăng nhập. Bấm “Kết nối Outlook” và đăng nhập tài khoản trường."
                : "Outlook phản hồi quá lâu. Hãy kiểm tra mạng rồi tải lại Hộp thư.");
            err.code = isLoginUrl(url) ? "OUTLOOK_LOGIN_REQUIRED" : "OUTLOOK_TIMEOUT";
            finish(null, err);
        }, waitMs);

        const captureHeaders = (headers, url) => {
            const auth = headers && (headers.Authorization || headers.authorization);
            if (auth) rememberBearer(auth, url);
        };
        const inspectResponse = async (requestId, url) => {
            if (!/graph\.microsoft\.com|outlook\.office\.com\/owa\/service\.svc/i.test(url)) return;
            if (!/messages|mailfolders|FindItem|GetItem|service\.svc|\\$batch/i.test(url)) return;
            try {
                const bodyResult = await wc.debugger.sendCommand("Network.getResponseBody", { requestId });
                if (!bodyResult || !bodyResult.body) return;
                const parsed = JSON.parse(bodyResult.body);
                const items = findMessagesInJson(parsed);
                if (!items.length) return;
                cacheMessages(items, /graph\.microsoft\.com/i.test(url) ? "microsoft-graph" : "outlook-web");
                finish({ messages: outlookCache.messages, source: outlookCache.source });
            } catch {
                /* Một số response là stream hoặc đã bị giải phóng; tiếp tục chờ response kế. */
            }
        };

        try {
            wc.debugger.attach("1.3");
        } catch {
            const err = new Error("Không thể mở phiên đọc dữ liệu Outlook.");
            err.code = "OUTLOOK_CAPTURE_FAILED";
            finish(null, err);
            return;
        }
        wc.debugger.on("message", (_event, method, params) => {
            if (method === "Network.requestWillBeSent") {
                const req = params.request || {};
                requestUrls.set(params.requestId, req.url || "");
                captureHeaders(req.headers || {}, req.url || "");
            } else if (method === "Network.requestWillBeSentExtraInfo") {
                captureHeaders(params.headers || {}, requestUrls.get(params.requestId) || "");
            } else if (method === "Network.responseReceived") {
                const response = params.response || {};
                requestUrls.set(params.requestId, response.url || requestUrls.get(params.requestId) || "");
            } else if (method === "Network.loadingFinished") {
                const url = requestUrls.get(params.requestId) || "";
                inspectResponse(params.requestId, url);
                requestUrls.delete(params.requestId);
            }
        });
        wc.debugger.sendCommand("Network.enable").catch(() => {});

        wc.on("did-navigate", (_event, url) => {
            if (!interactive && isLoginUrl(url)) {
                clearTimeout(loginTimer);
                loginTimer = setTimeout(() => {
                    if (!isLoginUrl(wc.getURL())) return;
                    const err = new Error("Outlook chưa đăng nhập. Bấm “Kết nối Outlook” và đăng nhập tài khoản trường.");
                    err.code = "OUTLOOK_LOGIN_REQUIRED";
                    finish(null, err);
                }, 7000);
            }
        });
        wc.on("did-finish-load", () => {
            if (isLoginUrl(wc.getURL())) return;
            // Có tenant chỉ gọi Graph, không gọi FindItem. Cho request nền chạy thêm rồi
            // trả quyền Graph về cho hàm gọi.
            setTimeout(() => {
                if (!settled && graphTokenIsUsable()) finish({ messages: [], source: "microsoft-graph" });
            }, 9000);
        });
        win.on("closed", () => {
            if (settled) return;
            const err = new Error("Bạn đã đóng cửa sổ trước khi kết nối Outlook xong.");
            err.code = "OUTLOOK_CONNECT_CLOSED";
            finish(null, err);
        });
        win.loadURL(OUTLOOK_INBOX_URL).catch((cause) => {
            const err = new Error("Không mở được Outlook: " + ((cause && cause.message) || cause));
            err.code = "OUTLOOK_LOAD_FAILED";
            finish(null, err);
        });
        if (interactive) win.focus();
    });
}

async function ensureOutlookAccess({ partition, interactive = false } = {}) {
    if (graphTokenIsUsable()) return { source: "microsoft-graph" };
    return captureOutlookSession({ partition, interactive });
}

async function connectOutlook({ partition } = {}) {
    const captured = await captureOutlookSession({ partition, interactive: true });
    return {
        connected: graphTokenIsUsable() || !!(captured.messages && captured.messages.length) || outlookCache.source === "outlook-web",
        account: currentAccount(),
        source: graphTokenIsUsable() ? "microsoft-graph" : (captured.source || "outlook-web"),
    };
}

/**
 * Gửi mail tự động qua Microsoft Graph. Kèm ảnh minh chứng (base64).
 */
async function sendViaOutlook({ partition, to, cc, subject, body, imagePath }) {
    if (!to) { const e = new Error("Thiếu email người nhận."); e.code = "MAIL_NO_TO"; throw e; }
    const message = {
        subject: subject || "Đơn xin phép nghỉ học",
        body: { contentType: "Text", content: body || "" },
        toRecipients: graphRecipients(to),
    };
    if (cc) message.ccRecipients = graphRecipients(cc);
    if (imagePath && fs.existsSync(imagePath)) {
        const buf = fs.readFileSync(imagePath);
        message.attachments = [{
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: path.basename(imagePath),
            contentBytes: buf.toString("base64"),
        }];
    }
    await ensureOutlookAccess({ partition });
    if (!graphTokenIsUsable()) {
        const err = new Error("Tài khoản trường chưa cấp quyền gửi tự động. Hãy dùng nút “Mở Outlook để gửi”.");
        err.code = "OUTLOOK_PERMISSION";
        throw err;
    }
    const res = await graphCall("post", "/me/sendMail", { message, saveToSentItems: true });
    return { ok: true, status: res.status };
}

// Lấy danh sách thư gần nhất (Inbox).
async function listMessages({ partition, top = 20 } = {}) {
    const limit = safeTop(top);
    let captured = null;
    let graphFailure = null;

    if (!graphTokenIsUsable() && Date.now() - outlookCache.fetchedAt < OUTLOOK_CACHE_MS) {
        return {
            messages: outlookCache.messages.slice(0, limit),
            account: currentAccount(),
            source: outlookCache.source || "outlook-web",
            capabilities: { fullMessage: false, reply: false, send: false },
        };
    }

    if (!graphTokenIsUsable()) captured = await ensureOutlookAccess({ partition });
    if (graphTokenIsUsable()) {
        try {
            const query = `/me/mailFolders/inbox/messages?$top=${limit}`
                + "&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink"
                + "&$orderby=receivedDateTime%20desc";
            const res = await graphCall("get", query);
            const items = ((res.data && res.data.value) || []).map((raw) => ({ raw, normalized: normalizeMessage(raw) }));
            const messages = cacheMessages(items, "microsoft-graph").slice(0, limit);
            return {
                messages,
                account: currentAccount(),
                source: "microsoft-graph",
                capabilities: { fullMessage: true, reply: true, send: true },
            };
        } catch (err) {
            graphFailure = err;
        }
    }

    const capturedMessages = (captured && captured.messages) || outlookCache.messages;
    if (capturedMessages && (capturedMessages.length || outlookCache.source === "outlook-web")) {
        return {
            messages: capturedMessages.slice(0, limit),
            account: currentAccount(),
            source: "outlook-web",
            capabilities: { fullMessage: false, reply: false, send: false },
        };
    }
    if (graphFailure) throw graphFailure;
    const err = new Error("Không tìm thấy dữ liệu thư trong phiên Outlook. Hãy bấm “Kết nối Outlook” rồi thử lại.");
    err.code = "OUTLOOK_NO_DATA";
    throw err;
}

// Lấy nội dung đầy đủ 1 thư.
async function getMessage({ partition, id } = {}) {
    if (!id) throw new Error("Thiếu id thư.");
    if (!graphTokenIsUsable()) await ensureOutlookAccess({ partition });
    if (graphTokenIsUsable()) {
        const query = `/me/messages/${encodeURIComponent(id)}`
            + "?$select=id,subject,from,toRecipients,receivedDateTime,body,webLink";
        const res = await graphCall("get", query, null, { Prefer: 'outlook.body-content-type="text"' });
        const message = normalizeMessage(res.data) || { id };
        cacheMessages([{ raw: res.data, normalized: message }], "microsoft-graph");
        return { ...message, canReply: true, limited: false };
    }

    const cached = outlookCache.messages.find((message) => message.id === id);
    if (cached) {
        return {
            ...cached,
            body: cached.body || cached.preview || "",
            canReply: false,
            limited: !cached.body,
        };
    }
    const err = new Error("Không tải được nội dung thư qua API. Bạn có thể mở thư này trực tiếp trong Outlook.");
    err.code = "OUTLOOK_OPEN_REQUIRED";
    throw err;
}

// Trả lời một thư (reply, giữ nguyên chuỗi hội thoại). comment = nội dung trả lời.
async function replyMessage({ partition, id, comment } = {}) {
    if (!id) throw new Error("Thiếu id thư.");
    if (!comment || !String(comment).trim()) {
        const err = new Error("Chưa có nội dung trả lời.");
        err.code = "MAIL_NO_BODY";
        throw err;
    }
    if (!graphTokenIsUsable()) await ensureOutlookAccess({ partition });
    if (!graphTokenIsUsable()) {
        const err = new Error("Tài khoản chưa cấp quyền trả lời tự động. Hãy mở thư trong Outlook để trả lời.");
        err.code = "OUTLOOK_OPEN_REQUIRED";
        throw err;
    }
    const res = await graphCall("post", `/me/messages/${encodeURIComponent(id)}/reply`, { comment: String(comment).trim() });
    return { ok: true, status: res.status };
}

function openOutlookMessage({ partition, id, webLink } = {}) {
    const { BrowserWindow } = require("electron");
    const cached = outlookCache.messages.find((message) => message.id === id);
    let url = webLink || (cached && cached.webLink) || "";
    if (!/^https:\/\/(?:outlook\.office(?:365)?\.com|outlook\.live\.com)\//i.test(url)) {
        url = id
            ? `https://outlook.office.com/mail/inbox/id/${encodeURIComponent(id)}`
            : OUTLOOK_INBOX_URL;
    }
    const win = new BrowserWindow({
        width: 1100,
        height: 840,
        title: "Hộp thư trường",
        autoHideMenuBar: true,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadURL(url);
    win.focus();
    return { opened: true, url };
}

function buildTransport() {
    const s = store.getSettings();
    const m = s.mail || {};
    if (!m.user || !m.pass) {
        const e = new Error("Chưa cấu hình email (user/App Password) trong Cài đặt.");
        e.code = "MAIL_NO_CONFIG";
        throw e;
    }
    if (m.service === "gmail") {
        return nodemailer.createTransport({ service: "gmail", auth: { user: m.user, pass: m.pass } });
    }
    return nodemailer.createTransport({
        host: m.host,
        port: Number(m.port) || 465,
        secure: m.secure !== false,
        auth: { user: m.user, pass: m.pass },
    });
}

async function verify() {
    const transport = buildTransport();
    await transport.verify();
    return true;
}

async function sendLeaveEmail({ to, cc, subject, body, imagePath }) {
    if (!to) {
        const e = new Error("Thiếu email người nhận (giảng viên).");
        e.code = "MAIL_NO_TO";
        throw e;
    }
    const s = store.getSettings();
    const m = s.mail || {};
    const transport = buildTransport();

    const attachments = [];
    if (imagePath && fs.existsSync(imagePath)) {
        attachments.push({ filename: path.basename(imagePath), path: imagePath });
    }

    const info = await transport.sendMail({
        from: (s.student && s.student.name ? `"${s.student.name}" ` : "") + `<${m.user}>`,
        to,
        cc: cc || undefined,
        subject: subject || "Đơn xin phép nghỉ học",
        text: body || "",
        attachments,
    });
    return { messageId: info.messageId, accepted: info.accepted || [] };
}

module.exports = {
    verify,
    sendLeaveEmail,
    connectOutlook,
    sendViaOutlook,
    listMessages,
    getMessage,
    replyMessage,
    openOutlookMessage,
    _internal: { jwtClaims, normalizeMessage, findMessagesInJson },
};
