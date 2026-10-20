// Wrapper quanh window.api: boc { ok, data } -> data, nem Error sach khi loi.

function unwrap(res) {
    if (!res || res.ok !== true) {
        const err = new Error((res && res.error) || "Loi khong xac dinh");
        err.code = res && res.code;
        throw err;
    }
    return res.data;
}

const raw = window.api;

export const store = {
    all: (c) => raw.store.all(c).then(unwrap),
    get: (c, id) => raw.store.get(c, id).then(unwrap),
    add: (c, item) => raw.store.add(c, item).then(unwrap),
    update: (c, id, patch) => raw.store.update(c, id, patch).then(unwrap),
    remove: (c, id) => raw.store.remove(c, id).then(unwrap),
    clear: (c) => raw.store.clear(c).then(unwrap),
};

export const settings = {
    get: () => raw.settings.get().then(unwrap),
    set: (patch) => raw.settings.set(patch).then(unwrap),
};

export const data = {
    info: () => raw.data.info().then(unwrap),
    openFolder: () => raw.data.openFolder().then(unwrap),
    wipeAll: () => raw.data.wipeAll().then(unwrap),
};

export const ai = {
    status: () => raw.ai.status().then(unwrap),
    ask: (prompt, opts) => raw.ai.ask(prompt, opts).then(unwrap),
    checkKnowledge: (s) => raw.ai.checkKnowledge(s).then(unwrap),
    explain: (t, history) => raw.ai.explain(t, history).then(unwrap),
    resetChat: () => raw.ai.resetChat().then(unwrap),
    planSchedule: (input) => raw.ai.planSchedule(input).then(unwrap),
    parseNaturalSchedule: (t) => raw.ai.parseNaturalSchedule(t).then(unwrap),
    examPlan: (id) => raw.ai.examPlan(id).then(unwrap),
    loadCookieFromText: (t) => raw.ai.loadCookieFromText(t).then(unwrap),
    connectGemini: () => raw.ai.connectGemini().then(unwrap),
};

export const sync = {
    autoStart: () => raw.sync.autoStart().then(unwrap),
    status: () => raw.sync.status().then(unwrap),
    resync: () => raw.sync.resync().then(unwrap),
    logout: (wipe) => raw.sync.logout(wipe).then(unwrap),
};

export const documents = {
    import: () => raw.documents.import().then(unwrap),
    summarize: (id) => raw.documents.summarize(id).then(unwrap),
    suggest: (id) => raw.documents.suggest(id).then(unwrap),
};

export const docx = {
    exportTextbook: (id) => raw.docx.exportTextbook(id).then(unwrap),
    exportAll: () => raw.docx.exportAll().then(unwrap),
};

export const mail = {
    draftLeave: (payload) => raw.mail.draftLeave(payload).then(unwrap),
    pickImage: () => raw.mail.pickImage().then(unwrap),
    send: (payload) => raw.mail.send(payload).then(unwrap),
    outlookCompose: (payload) => raw.mail.outlookCompose(payload).then(unwrap),
    connectOutlook: () => raw.mail.connectOutlook().then(unwrap),
    sendOutlook: (payload) => raw.mail.sendOutlook(payload).then(unwrap),
    inbox: (top) => raw.mail.inbox(top).then(unwrap),
    getMessage: (id) => raw.mail.getMessage(id).then(unwrap),
    openMessage: (id, webLink) => raw.mail.openMessage(id, webLink).then(unwrap),
    draftReply: (payload) => raw.mail.draftReply(payload).then(unwrap),
    reply: (id, comment) => raw.mail.reply(id, comment).then(unwrap),
    classify: (messages) => raw.mail.classify(messages).then(unwrap),
    verify: () => raw.mail.verify().then(unwrap),
};

export const on = (channel, cb) => raw.on(channel, cb);
