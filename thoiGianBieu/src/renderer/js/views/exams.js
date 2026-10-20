import * as api from "../api.js";
import { h, clear, modal, toast, confirmModal, fmtDate, daysUntil, todayISO, withButtonLoading } from "../ui.js";

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn primary", onClick: () => openForm(ctx) }, "+ Thêm lịch thi"),
    ]);
    await draw(container, ctx);
}

async function draw(container, ctx) {
    clear(container);
    const exams = (await api.store.all("exams")).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const upcoming = exams.filter((e) => (e.date || "") >= todayISO());
    const past = exams.filter((e) => (e.date || "") < todayISO());

    container.appendChild(h("div", { class: "note-box", text: "Lịch thi kèm đếm ngược. Bấm \"Lộ trình ôn (AI)\" để nhận kế hoạch ôn tập chi tiết." }));

    if (!exams.length) {
        container.appendChild(h("div", { class: "empty", style: "margin-top:14px", text: "Chưa có lịch thi. Thêm tay hoặc đồng bộ từ portal." }));
        return;
    }

    container.appendChild(h("div", { class: "section-title", text: "Sắp thi" }));
    if (!upcoming.length) container.appendChild(h("div", { class: "muted small", text: "Không có kỳ thi sắp tới." }));
    upcoming.forEach((e) => container.appendChild(examCard(e, ctx, false)));

    if (past.length) {
        container.appendChild(h("div", { class: "section-title", text: "Đã qua" }));
        past.forEach((e) => container.appendChild(examCard(e, ctx, true)));
    }
}

function examCard(e, ctx, isPast) {
    const d = daysUntil(e.date);
    const badge = isPast
        ? h("span", { class: "badge gray", text: "Đã thi" })
        : h("span", { class: `badge ${d <= 3 ? "red" : d <= 7 ? "orange" : "blue"}`, text: `Còn ${d} ngày` });

    return h("div", { class: "item" }, [
        h("div", { class: "item-main" }, [
            h("div", { class: "item-title", text: e.course }),
            h("div", { class: "item-sub", text: `${fmtDate(e.date)}${e.session ? " • Ca " + e.session : ""}${e.room ? " • Phòng " + e.room : ""}` }),
            e.note ? h("div", { class: "item-sub", text: e.note }) : "",
        ]),
        badge,
        h("div", { class: "item-actions" }, [
            !isPast ? h("button", { class: "btn small accent", onClick: (ev) => showExamPlan(e, ev.currentTarget) }, "Lộ trình ôn (AI)") : "",
            h("button", { class: "btn small ghost", onClick: () => openForm(ctx, e) }, "Sửa"),
            h("button", { class: "btn small danger", onClick: async () => {
                if (await confirmModal(`Xoá lịch thi môn "${e.course}"?`)) { await api.store.remove("exams", e.id); toast("Đã xoá", "ok"); draw(document.getElementById("view"), ctx); }
            } }, "Xoá"),
        ]),
    ]);
}

async function showExamPlan(exam, btn) {
    await withButtonLoading(btn, async () => {
        const plan = await api.ai.examPlan(exam.id);
        const body = h("div", {}, [
            h("div", { class: "note-box", text: `${exam.course} • Thi ngày ${fmtDate(exam.date)} • Còn ${plan.days} ngày` }),
            plan.summary ? h("p", { text: plan.summary }) : "",
            ...(plan.phases || []).map((p) => h("div", { class: "card", style: "margin-top:10px" }, [
                h("h3", { text: `${p.label}${p.range ? " — " + p.range : ""}` }),
                h("ul", {}, (p.tasks || []).map((t) => h("li", { text: t }))),
            ])),
        ]);
        modal({ title: "Lộ trình ôn thi", body, actions: [{ label: "Đóng", variant: "primary", onClick: (c) => c() }] });
    });
}

function openForm(ctx, exam) {
    const e = exam || {};
    const f = {};
    const field = (label, node, key) => { f[key] = node; return h("label", { class: "field" }, [h("span", { text: label }), node]); };
    const body = h("div", {}, [
        field("Môn thi", h("input", { value: e.course || "", placeholder: "VD: Cấu trúc dữ liệu" }), "course"),
        h("div", { class: "inline-form" }, [
            field("Ngày thi", h("input", { type: "date", value: e.date || "" }), "date"),
            field("Ca thi", h("input", { value: e.session || "", placeholder: "Ca 1" }), "session"),
            field("Phòng", h("input", { value: e.room || "", placeholder: "A101" }), "room"),
        ]),
        field("Ghi chú", h("textarea", {}, e.note || ""), "note"),
    ]);
    f.note.value = e.note || "";

    const actions = [{ label: "Huỷ", variant: "ghost", onClick: (c) => c() }];
    actions.push({
        label: exam ? "Lưu" : "Thêm", variant: "primary", onClick: async (close) => {
            const payload = {
                course: f.course.value.trim(),
                date: f.date.value,
                session: f.session.value.trim(),
                room: f.room.value.trim(),
                note: f.note.value.trim(),
                source: e.source || "manual",
            };
            if (!payload.course || !payload.date) { toast("Nhập môn thi và ngày thi", "warn"); return; }
            if (exam) await api.store.update("exams", e.id, payload);
            else await api.store.add("exams", payload);
            close(); toast(exam ? "Đã lưu" : "Đã thêm", "ok");
            draw(document.getElementById("view"), ctx);
        },
    });
    modal({ title: exam ? "Sửa lịch thi" : "Thêm lịch thi", body, actions });
}
