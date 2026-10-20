"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Bọc invoke để renderer chỉ thấy các kênh được phép.
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("api", {
    // ===== Kho dữ liệu cục bộ =====
    store: {
        all: (collection) => invoke("store:all", { collection }),
        get: (collection, id) => invoke("store:get", { collection, id }),
        add: (collection, item) => invoke("store:add", { collection, item }),
        update: (collection, id, patch) => invoke("store:update", { collection, id, patch }),
        remove: (collection, id) => invoke("store:remove", { collection, id }),
        clear: (collection) => invoke("store:clear", { collection }),
    },
    settings: {
        get: () => invoke("settings:get"),
        set: (patch) => invoke("settings:set", { patch }),
    },

    // ===== Dữ liệu cục bộ (mở thư mục / xoá toàn bộ) =====
    data: {
        info: () => invoke("data:info"),
        openFolder: () => invoke("data:openFolder"),
        wipeAll: () => invoke("data:wipeAll"),
    },

    // ===== Trợ lý AI =====
    ai: {
        status: () => invoke("ai:status"),
        ask: (prompt, opts) => invoke("ai:ask", { prompt, opts }),
        checkKnowledge: (statement) => invoke("ai:checkKnowledge", { statement }),
        explain: (topic, history) => invoke("ai:explain", { topic, history }),
        resetChat: () => invoke("ai:resetChat"),
        planSchedule: (input) => invoke("ai:planSchedule", { input }),
        parseNaturalSchedule: (text) => invoke("ai:parseNaturalSchedule", { text }),
        examPlan: (examId) => invoke("ai:examPlan", { examId }),
        loadCookieFromText: (text) => invoke("ai:loadCookie", { text }),
        connectGemini: () => invoke("ai:connectGemini"),
    },

    // ===== Đồng bộ portal trường (đăng nhập Microsoft 1 lần -> tự động cào cả 4) =====
    sync: {
        autoStart: () => invoke("sync:autoStart"),
        status: () => invoke("sync:status"),
        resync: () => invoke("sync:resync"),
        logout: (wipe) => invoke("sync:logout", { wipe }),
    },

    // ===== Tài liệu =====
    documents: {
        import: () => invoke("documents:import"),
        summarize: (id) => invoke("documents:summarize", { id }),
        suggest: (id) => invoke("documents:suggest", { id }),
    },

    // ===== Textbook / DOCX =====
    docx: {
        exportTextbook: (id) => invoke("docx:exportTextbook", { id }),
        exportAll: () => invoke("docx:exportAll"),
    },

    // ===== Email xin nghỉ =====
    mail: {
        draftLeave: (payload) => invoke("mail:draftLeave", payload),
        pickImage: () => invoke("mail:pickImage"),
        send: (payload) => invoke("mail:send", payload),
        outlookCompose: (payload) => invoke("mail:outlookCompose", payload),
        connectOutlook: () => invoke("mail:connectOutlook"),
        sendOutlook: (payload) => invoke("mail:sendOutlook", payload),
        inbox: (top) => invoke("mail:inbox", { top }),
        getMessage: (id) => invoke("mail:getMessage", { id }),
        openMessage: (id, webLink) => invoke("mail:openMessage", { id, webLink }),
        draftReply: (payload) => invoke("mail:draftReply", payload),
        reply: (id, comment) => invoke("mail:reply", { id, comment }),
        classify: (messages) => invoke("mail:classify", { messages }),
        verify: () => invoke("mail:verify"),
    },

    // ===== Sự kiện đẩy từ main (nhắc nhở) =====
    on: (channel, cb) => {
        const allowed = ["reminder:fired", "sync:progress", "ai:updated"];
        if (!allowed.includes(channel)) return () => {};
        const listener = (_e, data) => cb(data);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },
});
