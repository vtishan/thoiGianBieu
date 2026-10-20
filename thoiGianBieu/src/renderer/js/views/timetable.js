import * as api from "../api.js";
import { h, clear, modal, toast, confirmModal, DAY_VI } from "../ui.js";

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // T2..T7, CN

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn primary", onClick: () => openForm(ctx) }, "+ Thêm môn học"),
    ]);
    await draw(container, ctx);
}

async function draw(container, ctx) {
    clear(container);
    const courses = await api.store.all("courses");

    container.appendChild(h("div", { class: "note-box", text: "Thời khóa biểu theo tuần. Có thể thêm tay hoặc đồng bộ tự động từ portal (mục Đồng bộ portal)." }));

    const board = h("div", { class: "tt-grid", style: "grid-template-columns: repeat(7, 1fr); margin-top:14px" });
    for (const day of DAY_ORDER) {
        board.appendChild(h("div", { class: "tt-head", text: DAY_VI[day] }));
    }
    for (const day of DAY_ORDER) {
        const col = h("div", { class: "tt-col" });
        const dayCourses = courses
            .filter((c) => Number(c.day) === day)
            .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
        if (!dayCourses.length) {
            col.appendChild(h("div", { class: "muted small", style: "text-align:center;padding-top:14px", text: "—" }));
        }
        dayCourses.forEach((c) => {
            col.appendChild(h("div", { class: "tt-course " + (c.mode === "online" ? "online" : ""), onClick: () => openForm(ctx, c) }, [
                h("div", { class: "c-name", text: c.name || "(chưa đặt tên)" }),
                h("div", { class: "c-meta", text: `${c.start || "?"}–${c.end || "?"}` }),
                h("div", { class: "c-meta", text: c.mode === "online" ? "Online" : "P." + (c.room || "?") }),
            ]));
        });
        board.appendChild(col);
    }
    container.appendChild(board);

    if (!courses.length) {
        container.appendChild(h("div", { class: "empty", style: "margin-top:16px", text: "Chưa có môn học nào. Bấm \"Thêm môn học\" hoặc đồng bộ từ portal." }));
    }
}

function openForm(ctx, course) {
    const c = course || {};
    const f = {};
    const field = (label, node, key) => { f[key] = node; return h("label", { class: "field" }, [h("span", { text: label }), node]); };

    const daySel = h("select", {}, DAY_ORDER.map((d) => h("option", { value: String(d), selected: Number(c.day) === d }, DAY_VI[d])));
    const modeSel = h("select", {}, [
        h("option", { value: "offline", selected: c.mode !== "online" }, "Offline (trên trường)"),
        h("option", { value: "online", selected: c.mode === "online" }, "Online"),
    ]);

    const body = h("div", {}, [
        field("Tên môn học", h("input", { value: c.name || "", placeholder: "VD: Lập trình hướng đối tượng" }), "name"),
        h("div", { class: "inline-form" }, [
            field("Mã môn", h("input", { value: c.code || "", placeholder: "OOP101" }), "code"),
            field("Phòng", h("input", { value: c.room || "", placeholder: "A203" }), "room"),
        ]),
        field("Giảng viên", h("input", { value: c.lecturer || "", placeholder: "Tên giảng viên" }), "lecturer"),
        field("Email giảng viên", h("input", { value: c.lecturerEmail || "", placeholder: "gv@cmcu.edu.vn" }), "lecturerEmail"),
        h("div", { class: "inline-form" }, [
            field("Thứ", daySel, "day"),
            field("Bắt đầu", h("input", { type: "time", value: c.start || "07:00" }), "start"),
            field("Kết thúc", h("input", { type: "time", value: c.end || "09:30" }), "end"),
        ]),
        field("Hình thức", modeSel, "mode"),
    ]);

    const actions = [
        { label: "Huỷ", variant: "ghost", onClick: (close) => close() },
    ];
    if (course) {
        actions.push({
            label: "Xoá", variant: "danger", onClick: async (close) => {
                if (await confirmModal(`Xoá môn "${c.name}"?`)) {
                    await api.store.remove("courses", c.id);
                    close(); toast("Đã xoá môn học", "ok"); draw(document.getElementById("view"), ctx);
                }
            },
        });
    }
    actions.push({
        label: course ? "Lưu" : "Thêm", variant: "primary", onClick: async (close) => {
            const payload = {
                name: f.name.value.trim(),
                code: f.code.value.trim(),
                room: f.room.value.trim(),
                lecturer: f.lecturer.value.trim(),
                lecturerEmail: f.lecturerEmail.value.trim(),
                day: Number(f.day.value),
                start: f.start.value,
                end: f.end.value,
                mode: f.mode.value,
                source: c.source || "manual",
            };
            if (!payload.name) { toast("Nhập tên môn học", "warn"); return; }
            if (course) await api.store.update("courses", c.id, payload);
            else await api.store.add("courses", payload);
            close(); toast(course ? "Đã lưu" : "Đã thêm môn học", "ok");
            draw(document.getElementById("view"), ctx);
        },
    });

    modal({ title: course ? "Sửa môn học" : "Thêm môn học", body, actions });
}
