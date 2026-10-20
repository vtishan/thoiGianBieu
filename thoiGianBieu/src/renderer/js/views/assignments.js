import * as api from "../api.js";
import { h, clear, modal, toast, confirmModal, deadlineBadge, fmtDateTime } from "../ui.js";

let filter = "pending";
let sourceFilter = "all";

function sourceKey(value) {
    const source = String(value || "manual").toLowerCase();
    if (source.includes("edux")) return "edux";
    if (source.includes("elearning")) return "elearning";
    if (source.includes("lms")) return "lms";
    return "manual";
}

function sourceLabel(value) {
    return { edux: "EduX", elearning: "eLearning", lms: "LMS", manual: "Tự thêm" }[sourceKey(value)];
}

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn primary", onClick: () => openForm(ctx) }, "+ Thêm bài tập"),
    ]);
    await draw(container, ctx);
}

async function draw(container, ctx) {
    clear(container);
    const list = await api.store.all("assignments");

    const counts = {
        all: list.length,
        pending: list.filter((a) => !a.done).length,
        done: list.filter((a) => a.done).length,
    };

    const tabs = h("div", { class: "row wrap", style: "margin-bottom:14px" }, [
        tab("pending", `Chưa xong (${counts.pending})`, ctx, container),
        tab("all", `Tất cả (${counts.all})`, ctx, container),
        tab("done", `Đã xong (${counts.done})`, ctx, container),
    ]);
    container.appendChild(tabs);

    const sourceCounts = { all: list.length, edux: 0, elearning: 0, lms: 0, manual: 0 };
    list.forEach((item) => { sourceCounts[sourceKey(item.source)]++; });
    container.appendChild(h("div", { class: "row wrap", style: "margin-bottom:14px" }, [
        sourceTab("all", `Tất cả nguồn (${sourceCounts.all})`, ctx, container),
        sourceTab("edux", `EduX (${sourceCounts.edux})`, ctx, container),
        sourceTab("elearning", `eLearning (${sourceCounts.elearning})`, ctx, container),
        sourceTab("lms", `LMS (${sourceCounts.lms})`, ctx, container),
        sourceTab("manual", `Tự thêm (${sourceCounts.manual})`, ctx, container),
    ]));

    let items = list.slice();
    if (filter === "pending") items = items.filter((a) => !a.done);
    else if (filter === "done") items = items.filter((a) => a.done);
    if (sourceFilter !== "all") items = items.filter((a) => sourceKey(a.source) === sourceFilter);
    items.sort((a, b) => {
        if (!!a.done !== !!b.done) return a.done ? 1 : -1;
        const ta = a.deadline && !isNaN(new Date(a.deadline)) ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
        const tb = b.deadline && !isNaN(new Date(b.deadline)) ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
        if (ta !== tb) return ta - tb;
        return sourceLabel(a.source).localeCompare(sourceLabel(b.source), "vi") ||
            String(a.title || "").localeCompare(String(b.title || ""), "vi");
    });

    if (!items.length) {
        container.appendChild(h("div", { class: "empty", text: "Không có bài tập nào ở mục này." }));
        ctx.refreshBadges();
        return;
    }

    items.forEach((a) => {
        const b = deadlineBadge(a.deadline);
        const cb = h("input", { type: "checkbox", style: "width:18px;height:18px;margin-top:2px", checked: a.done });
        cb.addEventListener("change", async () => {
            await api.store.update("assignments", a.id, { done: cb.checked });
            toast(cb.checked ? "Đã đánh dấu hoàn thành" : "Đã mở lại", "ok");
            draw(container, ctx);
        });
        container.appendChild(h("div", { class: "item" + (a.done ? " done" : "") }, [
            cb,
            h("div", { class: "item-main" }, [
                h("div", { class: "item-title", text: a.title }),
                h("div", { class: "item-sub" }, [
                    (a.course || "—") + "  •  " + sourceLabel(a.source),
                    a.deadline ? h("span", {}, `  •  Hạn: ${fmtDateTime(a.deadline)}`) : "",
                ]),
                a.content ? h("div", { class: "item-sub", text: a.content.slice(0, 160) }) : "",
                a.url ? h("a", { href: a.url, target: "_blank", class: "small" }, "Mở bài tập trên " + sourceLabel(a.source)) : "",
            ]),
            a.deadline && !a.done ? h("span", { class: `badge ${b.cls}`, text: b.text }) : (a.done ? h("span", { class: "badge green", text: "Xong" }) : ""),
            h("div", { class: "item-actions" }, [
                h("button", { class: "btn small ghost", onClick: () => openForm(ctx, a) }, "Sửa"),
                h("button", { class: "btn small danger", onClick: async () => {
                    if (await confirmModal(`Xoá bài tập "${a.title}"?`)) { await api.store.remove("assignments", a.id); toast("Đã xoá", "ok"); draw(container, ctx); }
                } }, "Xoá"),
            ]),
        ]));
    });
    ctx.refreshBadges();
}

function tab(key, label, ctx, container) {
    return h("button", { class: "btn small " + (filter === key ? "primary" : "ghost"), onClick: () => { filter = key; draw(container, ctx); } }, label);
}

function sourceTab(key, label, ctx, container) {
    return h("button", {
        class: "btn small " + (sourceFilter === key ? "accent" : "ghost"),
        onClick: () => { sourceFilter = key; draw(container, ctx); },
    }, label);
}

function toLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openForm(ctx, asg) {
    const a = asg || {};
    const f = {};
    const field = (label, node, key) => { f[key] = node; return h("label", { class: "field" }, [h("span", { text: label }), node]); };
    const srcSel = h("select", {}, ["manual", "EduX", "eLearning", "LMS"].map((s) => h("option", { value: s, selected: (a.source || "manual") === s }, s === "manual" ? "Tự thêm" : s)));

    const body = h("div", {}, [
        field("Tên bài tập / công việc", h("input", { value: a.title || "", placeholder: "VD: Bài tập OOP chương 3" }), "title"),
        h("div", { class: "inline-form" }, [
            field("Môn học", h("input", { value: a.course || "", placeholder: "OOP" }), "course"),
            field("Nguồn", srcSel, "source"),
        ]),
        field("Hạn nộp", h("input", { type: "datetime-local", value: toLocalInput(a.deadline) }), "deadline"),
        field("Nội dung / ghi chú", h("textarea", { placeholder: "Mô tả yêu cầu bài tập…" }, a.content || ""), "content"),
    ]);
    f.content.value = a.content || "";

    const actions = [{ label: "Huỷ", variant: "ghost", onClick: (c) => c() }];
    actions.push({
        label: asg ? "Lưu" : "Thêm", variant: "primary", onClick: async (close) => {
            const payload = {
                title: f.title.value.trim(),
                course: f.course.value.trim(),
                source: f.source.value,
                deadline: f.deadline.value ? new Date(f.deadline.value).toISOString() : "",
                content: f.content.value.trim(),
                done: a.done || false,
            };
            if (!payload.title) { toast("Nhập tên bài tập", "warn"); return; }
            if (asg) await api.store.update("assignments", a.id, payload);
            else await api.store.add("assignments", payload);
            close(); toast(asg ? "Đã lưu" : "Đã thêm", "ok");
            draw(document.getElementById("view"), ctx);
        },
    });

    modal({ title: asg ? "Sửa bài tập" : "Thêm bài tập", body, actions });
}
