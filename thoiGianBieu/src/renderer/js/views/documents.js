import * as api from "../api.js";
import { h, clear, modal, toast, confirmModal, withButtonLoading } from "../ui.js";

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn primary", onClick: (e) => importDocs(e.currentTarget, container, ctx) }, "+ Thêm tài liệu"),
    ]);
    await draw(container, ctx);
}

async function importDocs(btn, container, ctx) {
    await withButtonLoading(btn, async () => {
        const res = await api.documents.import();
        if (res.canceled) return;
        const withErr = res.added.filter((d) => d.error);
        toast(`Đã thêm ${res.added.length} tài liệu` + (withErr.length ? ` (${withErr.length} không đọc được nội dung)` : ""), withErr.length ? "warn" : "ok");
        await draw(container, ctx);
    });
}

async function draw(container, ctx) {
    clear(container);
    const docs = await api.store.all("documents");
    const status = await api.ai.status();

    container.appendChild(h("div", { class: "note-box", text: "Upload slide/PDF/giáo trình/note. AI sẽ tóm tắt và ghi nhớ để cá nhân hoá gợi ý học tập. Hỗ trợ: PDF, TXT, MD." }));
    if (!status.ready) container.appendChild(h("div", { class: "warn-box", style: "margin-top:10px", text: "Trợ lý AI chưa sẵn sàng nên tài liệu sẽ được lưu nhưng chưa được tóm tắt. Hãy kiểm tra tại Cài đặt rồi bấm \"Tóm tắt (AI)\"." }));

    if (!docs.length) {
        container.appendChild(h("div", { class: "empty", style: "margin-top:14px", text: "Chưa có tài liệu nào." }));
        return;
    }

    docs.slice().reverse().forEach((d) => {
        const card = h("div", { class: "card", style: "margin-top:12px" }, [
            h("div", { class: "card-head" }, [
                h("h3", {}, [d.name, h("span", { class: "badge gray", style: "margin-left:8px", text: (d.type || "").toUpperCase() })]),
                h("div", { class: "item-actions" }, [
                    h("button", { class: "btn small accent", onClick: (e) => summarize(d, e.currentTarget, container, ctx) }, d.summary ? "Tóm tắt lại" : "Tóm tắt (AI)"),
                    h("button", { class: "btn small ghost", onClick: (e) => suggest(d, e.currentTarget) }, "Gợi ý luyện tập"),
                    h("button", { class: "btn small danger", onClick: async () => { if (await confirmModal(`Xoá tài liệu "${d.name}"?`)) { await api.store.remove("documents", d.id); toast("Đã xoá", "ok"); draw(container, ctx); } } }, "Xoá"),
                ]),
            ]),
        ]);
        if (d.error) card.appendChild(h("div", { class: "warn-box", text: "Không đọc được nội dung: " + d.error }));
        if (d.summary) card.appendChild(h("p", { text: d.summary }));
        else if (!d.error) card.appendChild(h("p", { class: "muted small", text: "Chưa có tóm tắt." }));
        if (Array.isArray(d.keywords) && d.keywords.length) {
            card.appendChild(h("div", { class: "row wrap", style: "gap:6px;margin:6px 0" }, d.keywords.map((k) => h("span", { class: "badge blue", text: k }))));
        }
        if (Array.isArray(d.suggestions) && d.suggestions.length) {
            card.appendChild(h("div", { class: "muted small", text: "Gợi ý học:" }));
            card.appendChild(h("ul", { style: "margin:4px 0" }, d.suggestions.map((s) => h("li", { text: s }))));
        }
        container.appendChild(card);
    });
}

async function summarize(doc, btn, container, ctx) {
    await withButtonLoading(btn, async () => {
        await api.documents.summarize(doc.id);
        toast("Đã tóm tắt xong", "ok");
        await draw(container, ctx);
    });
}

async function suggest(doc, btn) {
    await withButtonLoading(btn, async () => {
        const text = await api.documents.suggest(doc.id);
        modal({ title: "Gợi ý luyện tập — " + doc.name, body: h("pre", { class: "ai-out", text }), actions: [{ label: "Đóng", variant: "primary", onClick: (c) => c() }] });
    });
}
