import * as api from "../api.js";
import { h, clear, modal, toast, confirmModal, fmtDateTime } from "../ui.js";

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn primary", onClick: () => openForm(ctx) }, "+ Thêm nhắc nhở"),
    ]);
    await draw(container, ctx);
}

async function draw(container, ctx) {
    clear(container);
    const reminders = (await api.store.all("reminders")).sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));

    container.appendChild(h("div", { class: "note-box" }, [
        h("strong", { text: "Nhắc nhở tự động: " }),
        "Hệ thống tự nhắc trước giờ học 15 phút, nhắc bài tập khi còn 1 ngày và trong ngày hết hạn, và đếm ngược lịch thi (7/3/1 ngày) — không cần thêm tay. Dưới đây là các nhắc nhở tuỳ chỉnh của bạn.",
    ]));

    if (!reminders.length) {
        container.appendChild(h("div", { class: "empty", style: "margin-top:14px", text: "Chưa có nhắc nhở tuỳ chỉnh nào." }));
        return;
    }

    reminders.forEach((r) => {
        const overdue = new Date(r.time) < new Date();
        container.appendChild(h("div", { class: "item" }, [
            h("div", { class: "item-main" }, [
                h("div", { class: "item-title", text: r.title }),
                h("div", { class: "item-sub", text: `${fmtDateTime(r.time)}${r.note ? " • " + r.note : ""}` }),
            ]),
            r.fired ? h("span", { class: "badge gray", text: "Đã nhắc" }) : h("span", { class: `badge ${overdue ? "orange" : "green"}`, text: overdue ? "Chờ nhắc" : "Đã đặt" }),
            h("div", { class: "item-actions" }, [
                h("button", { class: "btn small ghost", onClick: () => openForm(ctx, r) }, "Sửa"),
                h("button", { class: "btn small danger", onClick: async () => { if (await confirmModal(`Xoá nhắc nhở "${r.title}"?`)) { await api.store.remove("reminders", r.id); toast("Đã xoá", "ok"); draw(container, ctx); } } }, "Xoá"),
            ]),
        ]));
    });
}

function toLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openForm(ctx, rem) {
    const r = rem || {};
    const title = h("input", { value: r.title || "", placeholder: "VD: Gọi điện đăng ký học phần" });
    const time = h("input", { type: "datetime-local", value: toLocalInput(r.time) });
    const note = h("textarea", {}, r.note || "");
    note.value = r.note || "";

    const body = h("div", {}, [
        h("label", { class: "field" }, [h("span", { text: "Nội dung" }), title]),
        h("label", { class: "field" }, [h("span", { text: "Thời điểm nhắc" }), time]),
        h("label", { class: "field" }, [h("span", { text: "Ghi chú" }), note]),
    ]);

    const actions = [{ label: "Huỷ", variant: "ghost", onClick: (c) => c() }];
    actions.push({
        label: rem ? "Lưu" : "Thêm", variant: "primary", onClick: async (close) => {
            if (!title.value.trim() || !time.value) { toast("Nhập nội dung và thời điểm", "warn"); return; }
            const payload = { title: title.value.trim(), time: new Date(time.value).toISOString(), note: note.value.trim(), fired: false };
            if (rem) await api.store.update("reminders", r.id, payload);
            else await api.store.add("reminders", payload);
            close(); toast(rem ? "Đã lưu" : "Đã thêm nhắc nhở", "ok");
            draw(document.getElementById("view"), ctx);
        },
    });
    modal({ title: rem ? "Sửa nhắc nhở" : "Thêm nhắc nhở", body, actions });
}
