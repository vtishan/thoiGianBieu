"use strict";

/**
 * Đăng ký toàn bộ IPC handler. Mỗi handler trả về { ok, data } hoặc { ok:false, error, code }
 * để renderer nhận thông báo lỗi sạch (thay vì lỗi bọc của Electron).
 */

const path = require("path");
const { ipcMain, dialog, app, shell } = require("electron");

const store = require("./store");
const ai = require("./ai");
const sync = require("./sync");
const browserLogin = require("./sync/browserLogin");
const docx = require("./docx");
const documents = require("./documents");
const mailer = require("./mailer");

function registerIpc(ctx = {}) {
    const getWindow = ctx.getWindow || (() => null);

    // Cấu hình thư mục lưu session cookie của AI.
    ai.setDataDir(store.getDataDir());

    // Đẩy tiến trình đăng nhập (CMC / Gemini) xuống renderer.
    const sendProgress = (data) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send("sync:progress", data);
    };
    sync.setProgressSender(sendProgress);

    const sendAiUpdated = () => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send("ai:updated");
    };

    // TỰ ĐỘNG nạp cookie Gemini đã lưu từ lần đăng nhập trước (không mở cửa sổ, không cần bấm).
    // Nếu trước đây đã đăng nhập Google trong app -> AI sẵn sàng ngay khi mở app.
    (async () => {
        try {
            const map = await browserLogin.autoLoadGeminiCookies();
            if (map && map["__Secure-1PSID"]) ai.setCookiesFromMap(map);
        } catch { /* ignore */ }
        sendAiUpdated();
    })();

    const handle = (channel, fn) => {
        ipcMain.handle(channel, async (_e, payload) => {
            try {
                return { ok: true, data: await fn(payload || {}) };
            } catch (err) {
                return { ok: false, error: (err && err.message) || String(err), code: (err && err.code) || "ERR" };
            }
        });
    };

    // ===== Store =====
    handle("store:all", ({ collection }) => store.all(collection));
    handle("store:get", ({ collection, id }) => store.get(collection, id));
    handle("store:add", ({ collection, item }) => store.add(collection, item));
    handle("store:update", ({ collection, id, patch }) => store.update(collection, id, patch));
    handle("store:remove", ({ collection, id }) => store.remove(collection, id));
    handle("store:clear", ({ collection }) => store.clear(collection));

    handle("settings:get", () => store.getSettings());
    handle("settings:set", ({ patch }) => store.setSettings(patch));

    // ===== Dữ liệu cục bộ (thư mục "data" cạnh app) =====
    handle("data:info", () => ({ dir: store.getDataDir() }));
    handle("data:openFolder", async () => {
        const dir = store.getDataDir();
        const err = await shell.openPath(dir); // trả chuỗi rỗng nếu mở được
        if (err) throw new Error(err);
        return { dir };
    });
    // Xoá TOÀN BỘ dữ liệu (mọi hồ sơ + cấu hình + phiên đăng nhập). Không thể hoàn tác.
    handle("data:wipeAll", async () => {
        store.wipeAllData();
        try { await browserLogin.clearAllSessions(); } catch { /* ignore */ }
        return { ok: true, dir: store.getDataDir() };
    });

    // ===== AI =====
    handle("ai:status", () => ai.status());
    handle("ai:ask", ({ prompt, opts }) => ai.ask(prompt, opts || {}));
    handle("ai:checkKnowledge", ({ statement }) => ai.checkKnowledge(statement));
    handle("ai:explain", ({ topic, history }) => ai.explain(topic, history));
    handle("ai:resetChat", () => ai.resetChat());
    handle("ai:planSchedule", ({ input }) => ai.planSchedule(input));
    handle("ai:parseNaturalSchedule", ({ text }) => ai.parseNaturalSchedule(text));
    handle("ai:examPlan", ({ examId }) => ai.examPlan(examId));
    handle("ai:loadCookie", ({ text }) => ai.loadCookieFromText(text));
    handle("ai:connectGemini", async () => {
        const map = await browserLogin.connectGemini({ onProgress: sendProgress });
        const res = ai.setCookiesFromMap(map);
        // Nếu đã đăng nhập portal từ trước, kết nối Gemini xong thì tự cào luôn.
        if (res.hasRequired) setTimeout(() => sync.maybeAutoCrawl(), 500);
        return { count: Object.keys(map).length, hasRequired: res.hasRequired };
    });

    // ===== Sync portal (đăng nhập 1 lần cho cả 4, tự động cào) =====
    handle("sync:autoStart", () => sync.autoStart());
    handle("sync:status", () => sync.status());
    handle("sync:resync", () => sync.resync());
    handle("sync:logout", ({ wipe }) => sync.logout({ wipe: !!wipe }));

    // ===== Tài liệu =====
    handle("documents:import", async () => {
        const win = getWindow();
        const res = await dialog.showOpenDialog(win, {
            title: "Chọn tài liệu để thêm",
            properties: ["openFile", "multiSelections"],
            filters: [
                { name: "Tài liệu", extensions: ["pdf", "txt", "md", "markdown", "csv"] },
                { name: "Tất cả", extensions: ["*"] },
            ],
        });
        if (res.canceled || !res.filePaths.length) return { added: [], canceled: true };

        const aiReady = ai.status().ready;
        const added = [];
        for (const filePath of res.filePaths) {
            const doc = await documents.readDocument(filePath);
            let summary = "";
            let keywords = [];
            let suggestions = [];
            if (aiReady && doc.text && !doc.error) {
                try {
                    const s = await ai.summarizeDocument(doc.name, doc.text);
                    summary = s.summary;
                    keywords = s.keywords;
                    suggestions = s.suggestions;
                } catch {
                    /* để trống nếu AI lỗi, vẫn lưu tài liệu */
                }
            }
            const saved = store.add("documents", {
                name: doc.name,
                path: doc.path,
                type: doc.type,
                text: doc.text,
                error: doc.error,
                summary,
                keywords,
                suggestions,
            });
            added.push(saved);
        }
        return { added, canceled: false };
    });

    handle("documents:summarize", async ({ id }) => {
        const doc = store.get("documents", id);
        if (!doc) throw new Error("Không tìm thấy tài liệu.");
        if (!doc.text) throw new Error("Tài liệu không có nội dung văn bản để tóm tắt.");
        const s = await ai.summarizeDocument(doc.name, doc.text);
        return store.update("documents", id, { summary: s.summary, keywords: s.keywords, suggestions: s.suggestions });
    });

    handle("documents:suggest", async ({ id }) => {
        const doc = store.get("documents", id);
        if (!doc) throw new Error("Không tìm thấy tài liệu.");
        return ai.suggestPractice(doc);
    });

    // ===== DOCX =====
    handle("docx:exportTextbook", async ({ id }) => {
        const entry = store.get("textbook", id);
        if (!entry) throw new Error("Không tìm thấy ghi chú.");
        const win = getWindow();
        const res = await dialog.showSaveDialog(win, {
            title: "Xuất ghi chú ra DOCX",
            defaultPath: path.join(app.getPath("documents"), safeName(entry.title || "ghi-chu") + ".docx"),
            filters: [{ name: "Word", extensions: ["docx"] }],
        });
        if (res.canceled || !res.filePath) return { canceled: true };
        await docx.exportEntry(entry, res.filePath);
        return { canceled: false, filePath: res.filePath };
    });

    handle("docx:exportAll", async () => {
        const entries = store.all("textbook");
        if (!entries.length) throw new Error("Chưa có ghi chú nào để xuất.");
        const win = getWindow();
        const res = await dialog.showSaveDialog(win, {
            title: "Xuất toàn bộ sổ tay ra DOCX",
            defaultPath: path.join(app.getPath("documents"), "so-tay-hoc-tap.docx"),
            filters: [{ name: "Word", extensions: ["docx"] }],
        });
        if (res.canceled || !res.filePath) return { canceled: true };
        await docx.exportEntries(entries, res.filePath);
        return { canceled: false, filePath: res.filePath };
    });

    // ===== Mail =====
    handle("mail:draftLeave", (payload) => ai.draftLeaveEmail(payload));
    handle("mail:verify", () => mailer.verify());
    handle("mail:pickImage", async () => {
        const win = getWindow();
        const res = await dialog.showOpenDialog(win, {
            title: "Chọn ảnh minh chứng",
            properties: ["openFile"],
            filters: [{ name: "Ảnh", extensions: ["jpg", "jpeg", "png", "gif", "webp", "pdf"] }],
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        return { canceled: false, path: res.filePaths[0] };
    });
    handle("mail:send", (payload) => mailer.sendLeaveEmail(payload));
    // Gửi bằng tài khoản Microsoft: mở Outlook Web (đã đăng nhập) với nội dung điền sẵn.
    handle("mail:outlookCompose", (payload) => browserLogin.openOutlookCompose(payload || {}));

    // ===== Hộp thư Outlook =====
    // Dùng cùng partition Microsoft SSO của các portal. Mailer ưu tiên Graph hiện hành
    // và tự dự phòng bằng dữ liệu Outlook Web nếu tenant không cấp quyền Graph.
    const outlookSession = () => ({ partition: browserLogin.CMC_PARTITION });
    handle("mail:connectOutlook", () => mailer.connectOutlook(outlookSession()));
    handle("mail:sendOutlook", ({ to, cc, subject, body, imagePath }) =>
        mailer.sendViaOutlook({ ...outlookSession(), to, cc, subject, body, imagePath })
    );
    handle("mail:inbox", ({ top } = {}) => mailer.listMessages({ ...outlookSession(), top }));
    handle("mail:getMessage", ({ id }) => mailer.getMessage({ ...outlookSession(), id }));
    handle("mail:openMessage", ({ id, webLink }) =>
        mailer.openOutlookMessage({ ...outlookSession(), id, webLink })
    );
    handle("mail:draftReply", (payload) => ai.draftReplyEmail(payload || {}));
    handle("mail:classify", ({ messages }) => ai.classifyEmails(messages || []));
    handle("mail:reply", ({ id, comment }) =>
        mailer.replyMessage({ ...outlookSession(), id, comment })
    );
}

function safeName(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

module.exports = { registerIpc };
