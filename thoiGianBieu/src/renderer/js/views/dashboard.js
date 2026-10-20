import * as api from "../api.js";
import { h, DAY_VI, fmtDate, deadlineBadge, daysUntil, todayISO } from "../ui.js";

export async function render(container, ctx) {
    const [courses, assignments, exams, textbook, docs] = await Promise.all([
        api.store.all("courses"),
        api.store.all("assignments"),
        api.store.all("exams"),
        api.store.all("textbook"),
        api.store.all("documents"),
    ]);
    const settings = await api.settings.get();

    const pending = assignments.filter((a) => !a.done);
    const today = new Date();
    const dow = today.getDay();
    const todayCourses = courses
        .filter((c) => Number(c.day) === dow)
        .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    const upcomingExams = exams
        .filter((e) => (e.date || "") >= todayISO())
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const soonAsg = pending
        .filter((a) => a.deadline)
        .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
        .slice(0, 6);

    const hello = settings.student && settings.student.name ? `Xin chào, ${settings.student.name}!` : "Xin chào!";

    container.appendChild(h("div", { class: "note-box", text: `${hello} Hôm nay là ${fmtDate(todayISO())}.` }));

    // Thong ke
    const stats = h("div", { class: "grid cols-4", style: "margin-top:16px" }, [
        stat("Môn học tuần này", courses.length, "trong thời khóa biểu"),
        stat("Bài tập chưa xong", pending.length, pending.length ? "cần hoàn thành" : "tất cả đã xong"),
        stat("Kỳ thi sắp tới", upcomingExams.length, upcomingExams[0] ? `gần nhất còn ${daysUntil(upcomingExams[0].date)} ngày` : "chưa có"),
        stat("Tài liệu & ghi chú", docs.length + textbook.length, `${docs.length} tài liệu, ${textbook.length} ghi chú`),
    ]);
    container.appendChild(stats);

    const cols = h("div", { class: "grid cols-2", style: "margin-top:16px" });

    // Lich hom nay
    const todayCard = h("div", { class: "card" }, [h("div", { class: "card-head" }, [h("h3", { text: "Lịch học hôm nay" }), h("button", { class: "btn small ghost", onClick: () => ctx.navigate("timetable") }, "Xem TKB")])]);
    if (!todayCourses.length) {
        todayCard.appendChild(h("div", { class: "empty", text: "Hôm nay không có tiết học nào." }));
    } else {
        todayCourses.forEach((c) => {
            todayCard.appendChild(h("div", { class: "slot " + (c.mode === "online" ? "online" : "fixed") }, [
                h("div", { class: "slot-time", text: `${c.start || "?"}–${c.end || "?"}` }),
                h("div", {}, [
                    h("div", { text: c.name }),
                    h("div", { class: "muted small", text: `${c.mode === "online" ? "Học online" : "Phòng " + (c.room || "?")}${c.lecturer ? " • " + c.lecturer : ""}` }),
                ]),
            ]));
        });
    }
    cols.appendChild(todayCard);

    // Bai tap sap toi han
    const asgCard = h("div", { class: "card" }, [h("div", { class: "card-head" }, [h("h3", { text: "Bài tập sắp tới hạn" }), h("button", { class: "btn small ghost", onClick: () => ctx.navigate("assignments") }, "Tất cả")])]);
    if (!soonAsg.length) {
        asgCard.appendChild(h("div", { class: "empty", text: "Không có bài tập nào sắp tới hạn." }));
    } else {
        soonAsg.forEach((a) => {
            const b = deadlineBadge(a.deadline);
            asgCard.appendChild(h("div", { class: "item" }, [
                h("div", { class: "item-main" }, [
                    h("div", { class: "item-title", text: a.title }),
                    h("div", { class: "item-sub", text: `${a.course || "—"}${a.source ? " • " + a.source : ""}` }),
                ]),
                h("span", { class: `badge ${b.cls}`, text: b.text }),
            ]));
        });
    }
    cols.appendChild(asgCard);
    container.appendChild(cols);

    // Ky thi + hanh dong nhanh
    const cols2 = h("div", { class: "grid cols-2", style: "margin-top:16px" });
    const examCard = h("div", { class: "card" }, [h("div", { class: "card-head" }, [h("h3", { text: "Đếm ngược kỳ thi" }), h("button", { class: "btn small ghost", onClick: () => ctx.navigate("exams") }, "Lịch thi")])]);
    if (!upcomingExams.length) {
        examCard.appendChild(h("div", { class: "empty", text: "Chưa có lịch thi." }));
    } else {
        upcomingExams.slice(0, 4).forEach((e) => {
            const d = daysUntil(e.date);
            examCard.appendChild(h("div", { class: "item" }, [
                h("div", { class: "item-main" }, [
                    h("div", { class: "item-title", text: e.course }),
                    h("div", { class: "item-sub", text: `${fmtDate(e.date)}${e.room ? " • Phòng " + e.room : ""}` }),
                ]),
                h("span", { class: `badge ${d <= 3 ? "red" : d <= 7 ? "orange" : "blue"}`, text: `Còn ${d} ngày` }),
            ]));
        });
    }
    cols2.appendChild(examCard);

    const quick = h("div", { class: "card" }, [h("h3", { text: "Bắt đầu nhanh" })]);
    const grid = h("div", { class: "grid cols-2" }, [
        quickBtn("Nhờ AI lập lịch học", "planner", ctx),
        quickBtn("Hỏi trợ lý AI", "assistant", ctx),
        quickBtn("Thêm bài tập", "assignments", ctx),
        quickBtn("Đồng bộ portal", "sync", ctx),
        quickBtn("Ghi chú Textbook", "textbook", ctx),
        quickBtn("Viết đơn xin nghỉ", "leave", ctx),
    ]);
    quick.appendChild(grid);
    cols2.appendChild(quick);
    container.appendChild(cols2);
}

function stat(label, value, sub) {
    return h("div", { class: "stat" }, [
        h("div", { class: "label", text: label }),
        h("div", { class: "value", text: String(value) }),
        h("div", { class: "sub", text: sub || "" }),
    ]);
}

function quickBtn(label, route, ctx) {
    return h("button", { class: "btn block", style: "justify-content:flex-start", onClick: () => ctx.navigate(route) }, label);
}
