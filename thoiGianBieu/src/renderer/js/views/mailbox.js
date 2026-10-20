import * as api from "../api.js";
import { h, clear, toast, modal, fmtDateTime, withButtonLoading } from "../ui.js";

const CAT_COLOR = {
    "Bài tập/Deadline": "red",
    "Học phí/Tài chính": "orange",
    "Thông báo trường": "blue",
    "Học tập": "green",
    "Cá nhân": "gray",
    "Quảng cáo/Spam": "gray",
    "Khác": "gray",
};

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn ghost small", onClick: () => render(container, ctx) }, "Tải lại"),
        h("button", { class: "btn primary small", onClick: (e) => connectOutlook(e.currentTarget, container, ctx) }, "Kết nối Outlook"),
    ]);
    clear(container);
    container.appendChild(h("div", { class: "note-box", text: "Hộp thư trường (Outlook) — đọc bằng chính tài khoản Microsoft đã đăng nhập. AI tự phân loại; bấm một thư để xem và nhờ AI soạn trả lời." }));

    const host = h("div", { style: "margin-top:12px" });
    container.appendChild(host);
    host.appendChild(h("div", { class: "loading-inline" }, [h("span", { class: "spinner" }), "Đang tải hộp thư…"]));

    let messages = [];
    let mailbox = null;
    try {
        mailbox = await api.mail.inbox(20);
        messages = Array.isArray(mailbox) ? mailbox : (mailbox.messages || []);
    } catch (e) {
        clear(host);
        host.appendChild(h("div", { class: "warn-box" }, [
            "Không đọc được hộp thư: " + (e.message || e) + ". ",
            h("button", { class: "btn primary small", onClick: (ev) => connectOutlook(ev.currentTarget, container, ctx) }, "Kết nối Outlook"),
        ]));
        return;
    }

    clear(host);
    if (mailbox && !Array.isArray(mailbox)) {
        const account = mailbox.account || {};
        const source = mailbox.source === "microsoft-graph" ? "Microsoft Graph" : "Outlook Web";
        host.appendChild(h("div", { class: "note-box", style: "margin-bottom:12px" }, [
            h("strong", { text: account.name || "Tài khoản Microsoft" }),
            account.email ? ` • ${account.email}` : "",
            ` • Nguồn: ${source}`,
        ]));
    }
    if (!messages.length) { host.appendChild(h("div", { class: "empty", text: "Hộp thư trống." })); return; }

    const listWrap = h("div", {});
    host.appendChild(listWrap);
    drawList(listWrap, messages, "Tất cả");

    // Phân loại AI (chạy sau, không chặn hiển thị).
    const aiNote = h("div", { class: "muted small", style: "margin:6px 0 12px" }, [h("span", { class: "spinner" }), " AI đang phân loại…"]);
    listWrap.prepend(aiNote);
    try {
        const cats = await api.mail.classify(messages);
        const map = {};
        cats.forEach((c) => { map[c.id] = c; });
        messages.forEach((m) => { const c = map[m.id] || {}; m.category = c.category || "Khác"; m.important = !!c.important; });
        drawList(listWrap, messages, "Tất cả");
    } catch {
        aiNote.remove();
    }
}

async function connectOutlook(btn, container, ctx) {
    await withButtonLoading(btn, async () => {
        const result = await api.mail.connectOutlook();
        const account = result.account || {};
        toast(`Đã kết nối${account.email ? ": " + account.email : ""}`, "ok", "Outlook");
        await render(container, ctx);
    });
}

function drawList(wrap, messages, active) {
    clear(wrap);
    const cats = ["Tất cả", ...Array.from(new Set(messages.map((m) => m.category).filter(Boolean)))];
    wrap.appendChild(h("div", { class: "row wrap", style: "margin-bottom:12px" }, cats.map((cat) =>
        h("button", { class: "btn small " + (active === cat ? "primary" : "ghost"), onClick: () => drawList(wrap, messages, cat) }, cat)
    )));
    const shown = messages.filter((m) => active === "Tất cả" || m.category === active);
    if (!shown.length) { wrap.appendChild(h("div", { class: "empty", text: "Không có thư trong nhóm này." })); return; }
    shown.forEach((m) => wrap.appendChild(mailItem(m)));
}

function mailItem(m) {
    const tags = [];
    if (m.important) tags.push(h("span", { class: "badge red", text: "Quan trọng" }));
    if (m.category) tags.push(h("span", { class: "badge " + (CAT_COLOR[m.category] || "gray"), text: m.category }));
    if (m.hasAttachments) tags.push(h("span", { class: "badge gray", text: "Đính kèm" }));
    return h("div", { class: "item", style: m.isRead ? "" : "border-left:3px solid var(--primary)" }, [
        h("div", { class: "item-main" }, [
            h("div", { class: "item-title", text: m.subject }),
            h("div", { class: "item-sub", text: `${m.from || m.fromAddress} • ${fmtDateTime(m.received)}` }),
            h("div", { class: "item-sub muted", text: (m.preview || "").slice(0, 140) }),
            tags.length ? h("div", { class: "row wrap", style: "gap:6px;margin-top:6px" }, tags) : "",
        ]),
        h("button", { class: "btn small ghost", onClick: (e) => openMail(m, e.currentTarget) }, "Xem / Trả lời"),
    ]);
}

async function openMail(m, btn) {
    await withButtonLoading(btn, async () => {
        const full = await api.mail.getMessage(m.id);
        showMailModal(full);
    });
}

function showMailModal(full) {
    const replyBox = h("textarea", { style: "min-height:170px", placeholder: "Nội dung trả lời — bấm \"AI soạn trả lời\" hoặc tự viết." });
    const aiBtn = h("button", { class: "btn accent" }, "AI soạn trả lời");
    const sendBtn = h("button", { class: "btn primary" }, "Gửi trả lời");
    const openBtn = h("button", { class: "btn ghost" }, "Mở trong Outlook");
    const canReply = full.canReply !== false;
    if (!canReply) {
        aiBtn.disabled = true;
        sendBtn.disabled = true;
    }

    const body = h("div", {}, [
        h("div", { class: "muted small", text: `Từ: ${full.from || full.fromAddress} • ${fmtDateTime(full.received)}` }),
        h("pre", { class: "ai-out", style: "max-height:240px; overflow:auto; margin:10px 0" }, full.body || "(không có nội dung)"),
        h("div", { class: "divider" }),
        h("label", { class: "field" }, [h("span", { text: "Trả lời" }), replyBox]),
        full.limited ? h("div", { class: "warn-box", text: "Phiên này chỉ đọc được phần xem trước. Mở Outlook để xem hoặc trả lời đầy đủ." }) : "",
        h("div", { class: "row wrap" }, [aiBtn, sendBtn, openBtn]),
    ]);

    const ref = modal({ title: full.subject || "(thư)", body, actions: [{ label: "Đóng", variant: "ghost", onClick: (c) => c() }] });

    aiBtn.addEventListener("click", () => withButtonLoading(aiBtn, async () => {
        const r = await api.mail.draftReply({ subject: full.subject, from: full.from || full.fromAddress, body: full.body });
        replyBox.value = r.reply || "";
        toast("AI đã soạn trả lời, kiểm tra rồi gửi.", "ok");
    }));
    openBtn.addEventListener("click", async () => {
        await api.mail.openMessage(full.id, full.webLink || "");
    });
    sendBtn.addEventListener("click", () => withButtonLoading(sendBtn, async () => {
        if (!replyBox.value.trim()) { toast("Chưa có nội dung trả lời", "warn"); return; }
        await api.mail.reply(full.id, replyBox.value.trim());
        toast("Đã gửi trả lời tới " + (full.from || full.fromAddress), "ok", "Đã gửi");
        ref.close();
    }));
}
