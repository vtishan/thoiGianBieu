import * as api from "../api.js";
import { h, clear, DAY_VI, fmtDate, fmtDateTime, daysUntil, deadlineBadge, todayISO } from "../ui.js";

export async function render(container, ctx) {
    ctx.setActions([]);
    clear(container);

    const [settings, courses, assignments, exams, announcements, materials, grades, tuition] = await Promise.all([
        api.settings.get(),
        api.store.all("courses"),
        api.store.all("assignments"),
        api.store.all("exams"),
        api.store.all("announcements"),
        api.store.all("materials"),
        api.store.all("grades"),
        api.store.all("tuition"),
    ]);
    const st = settings.student || {};

    const hasAny = courses.length || assignments.length || exams.length || announcements.length || materials.length || grades.length || tuition.length;
    if (!hasAny) {
        container.appendChild(h("div", { class: "empty" }, [
            "Chưa có dữ liệu. Mở mục ", h("a", { href: "#sync" }, "Đồng bộ portal"), " và đăng nhập Microsoft — hệ thống sẽ tự động cào: thời khóa biểu & lịch thi (IU), bài tập/thông báo/tài liệu (eLearning, LMS, EduX).",
        ]));
        return;
    }

    const pending = assignments.filter((a) => !a.done);
    const upExams = exams.filter((e) => (e.date || "") >= todayISO());

    container.appendChild(h("div", { class: "grid cols-4" }, [
        stat("Môn học (TKB)", courses.length, "từ IU"),
        stat("Bài tập chưa xong", pending.length, `${assignments.length} bài tổng hợp`),
        stat("Kỳ thi sắp tới", upExams.length, upExams[0] ? `gần nhất còn ${daysUntil(upExams[0].date)} ngày` : "—"),
        stat("Thông báo / Tài liệu", announcements.length + materials.length, `${announcements.length} tb, ${materials.length} tài liệu`),
    ]));

    // Hồ sơ sinh viên (mục #hoso của IU) — hiện nếu có.
    if (st.name || st.mssv || st.class || st.major || st.gpa != null || st.dob || st.faculty) {
        container.appendChild(h("div", { class: "card", style: "margin-top:16px" }, [
            h("h3", { text: "Hồ sơ sinh viên" }),
            h("div", { class: "grid cols-3" }, [
                info("Họ tên", st.name), info("MSSV", st.mssv), info("Ngày sinh", st.dob),
                info("Giới tính", st.gender), info("Lớp", st.class), info("Khóa", st.cohort),
                info("Ngành", st.major), info("Khoa", st.faculty), info("GPA/CPA", st.gpa != null ? `${st.gpa}${st.cpa != null ? " / " + st.cpa : ""}` : ""),
                info("Email", st.email), info("Điện thoại", st.phone), info("Địa chỉ", st.address),
            ]),
            st.creditsEarned != null || st.creditsTotal != null
                ? h("div", { class: "muted small", style: "margin-top:6px", text: `Tín chỉ tích lũy: ${st.creditsEarned != null ? st.creditsEarned : "?"}${st.creditsTotal != null ? " / " + st.creditsTotal : ""}` })
                : "",
        ]));
    }

    const cols = h("div", { class: "grid cols-2", style: "margin-top:16px" });

    // Thời khóa biểu (IU)
    const ttCard = h("div", { class: "card" }, [h("div", { class: "card-head" }, [h("h3", { text: "Thời khóa biểu (IU)" }), h("a", { href: "#timetable", class: "small" }, "Chi tiết →")])]);
    if (!courses.length) ttCard.appendChild(h("div", { class: "empty", text: "Chưa có." }));
    else {
        const byDay = groupBy(courses, (c) => Number(c.day));
        [1, 2, 3, 4, 5, 6, 0].filter((d) => byDay[d]).forEach((d) => {
            ttCard.appendChild(h("div", { class: "muted small", style: "margin-top:6px;font-weight:600", text: DAY_VI[d] }));
            byDay[d].sort((a, b) => (a.start || "").localeCompare(b.start || "")).forEach((c) =>
                ttCard.appendChild(h("div", { class: "slot " + (c.mode === "online" ? "online" : "fixed") }, [
                    h("div", { class: "slot-time", text: `${c.start || "?"}–${c.end || "?"}` }),
                    h("div", {}, [h("div", { text: c.name }), h("div", { class: "muted small", text: c.mode === "online" ? "Online" : "P." + (c.room || "?") })]),
                ])));
        });
    }
    cols.appendChild(ttCard);

    // Lịch thi (IU)
    const exCard = h("div", { class: "card" }, [h("div", { class: "card-head" }, [h("h3", { text: "Lịch thi (IU)" }), h("a", { href: "#exams", class: "small" }, "Chi tiết →")])]);
    if (!upExams.length) exCard.appendChild(h("div", { class: "empty", text: "Chưa có kỳ thi sắp tới." }));
    else upExams.sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach((e) => {
        const d = daysUntil(e.date);
        exCard.appendChild(h("div", { class: "item" }, [
            h("div", { class: "item-main" }, [h("div", { class: "item-title", text: e.course }), h("div", { class: "item-sub", text: `${fmtDate(e.date)}${e.room ? " • P." + e.room : ""}${e.session ? " • Ca " + e.session : ""}` })]),
            h("span", { class: `badge ${d <= 3 ? "red" : d <= 7 ? "orange" : "blue"}`, text: `Còn ${d} ngày` }),
        ]));
    });
    cols.appendChild(exCard);
    container.appendChild(cols);

    // Bài tập tổng hợp (nhóm theo nguồn)
    const asgCard = h("div", { class: "card", style: "margin-top:16px" }, [h("div", { class: "card-head" }, [h("h3", { text: `Bài tập tổng hợp (${assignments.length})` }), h("a", { href: "#assignments", class: "small" }, "Quản lý →")])]);
    if (!assignments.length) asgCard.appendChild(h("div", { class: "empty", text: "Chưa cào được bài tập nào." }));
    else {
        const bySrc = groupBy(assignments, (a) => sourceLabel(a.source));
        Object.keys(bySrc).sort().forEach((src) => {
            asgCard.appendChild(h("div", { class: "section-title", text: src + ` (${bySrc[src].length})` }));
            bySrc[src].slice().sort((a, b) => new Date(a.deadline || "9999") - new Date(b.deadline || "9999")).forEach((a) => {
                const b = deadlineBadge(a.deadline);
                asgCard.appendChild(h("div", { class: "item" + (a.done ? " done" : "") }, [
                    h("div", { class: "item-main" }, [
                        h("div", { class: "item-title", text: a.title }),
                        h("div", { class: "item-sub", text: `${a.course || "—"}${a.deadline ? " • Hạn: " + fmtDateTime(a.deadline) : ""}` }),
                    ]),
                    a.done ? h("span", { class: "badge green", text: "Đã nộp" }) : (a.deadline ? h("span", { class: `badge ${b.cls}`, text: b.text }) : ""),
                ]));
            });
        });
    }
    container.appendChild(asgCard);

    const cols2 = h("div", { class: "grid cols-2", style: "margin-top:16px" });

    // Thông báo
    const annCard = h("div", { class: "card" }, [h("h3", { text: `Thông báo (${announcements.length})` })]);
    if (!announcements.length) annCard.appendChild(h("div", { class: "empty", text: "Chưa có." }));
    else announcements.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 25).forEach((a) =>
        annCard.appendChild(h("div", { class: "item" }, [h("div", { class: "item-main" }, [
            h("div", { class: "item-title", text: a.title || "(thông báo)" }),
            h("div", { class: "item-sub", text: (a.date ? fmtDate(a.date) + " • " : "") + (a.content || "").slice(0, 180) }),
            a.source ? h("span", { class: "badge gray", text: sourceLabel(a.source) }) : "",
        ])])));
    cols2.appendChild(annCard);

    // Tài liệu / bài giảng
    const matCard = h("div", { class: "card" }, [h("h3", { text: `Tài liệu / bài giảng (${materials.length})` })]);
    if (!materials.length) matCard.appendChild(h("div", { class: "empty", text: "Chưa có." }));
    else {
        const byCourse = groupBy(materials, (m) => m.course || "Khác");
        Object.keys(byCourse).forEach((cs) => {
            matCard.appendChild(h("div", { class: "section-title", text: cs }));
            byCourse[cs].slice(0, 30).forEach((m) => matCard.appendChild(h("div", { class: "item" }, [h("div", { class: "item-main" }, [
                m.url ? h("a", { href: m.url, target: "_blank", rel: "noreferrer", class: "item-title" }, m.title || m.url) : h("div", { class: "item-title", text: m.title || "(tài liệu)" }),
                h("div", { class: "item-sub", text: `${m.type || "tài liệu"}${m.note ? " • " + m.note : ""}${m.source ? " • " + sourceLabel(m.source) : ""}` }),
            ])])));
        });
    }
    cols2.appendChild(matCard);
    container.appendChild(cols2);

    // Bảng điểm / học phí (chỉ hiện nếu có)
    if (grades.length) {
        const gcard = h("div", { class: "card", style: "margin-top:16px" }, [h("h3", { text: `Bảng điểm (${grades.length})` })]);
        const t = table(["Môn", "Mã", "TC", "Hệ 10", "Hệ 4", "Chữ", "HK"]);
        grades.forEach((g) => t.appendChild(rowEl([g.course, g.code, g.credits, num(g.score10), num(g.score4), g.letter, g.semester])));
        gcard.appendChild(t); container.appendChild(gcard);
    }
    if (tuition.length) {
        const tcard = h("div", { class: "card", style: "margin-top:16px" }, [h("h3", { text: "Học phí" })]);
        const t = table(["Học kỳ", "Phải đóng", "Đã đóng", "Còn nợ", "Trạng thái"]);
        tuition.forEach((x) => { const due = num(x.due) != null ? num(x.due) : Math.max(0, (num(x.amount) || 0) - (num(x.paid) || 0)); t.appendChild(rowEl([x.semester, vnd(x.amount), vnd(x.paid), vnd(due), x.status || (due > 0 ? "Còn nợ" : "Đã đóng")])); });
        tcard.appendChild(t); container.appendChild(tcard);
    }
}

function stat(label, value, sub) {
    return h("div", { class: "stat" }, [h("div", { class: "label", text: label }), h("div", { class: "value", text: String(value) }), h("div", { class: "sub", text: sub || "" })]);
}
function info(label, val) {
    return h("div", { style: "margin-bottom:8px" }, [h("div", { class: "muted small", text: label }), h("div", { text: val || "—" })]);
}
function sourceLabel(src) {
    if (!src) return "Tự thêm";
    if (String(src).startsWith("portal:")) return String(src).replace("portal:", "").toUpperCase();
    return String(src);
}
function groupBy(arr, fn) {
    const out = {};
    for (const x of arr) { const k = fn(x); (out[k] = out[k] || []).push(x); }
    return out;
}
function table(headers) {
    const t = document.createElement("table");
    t.className = "data-table";
    t.appendChild(rowEl(headers, true));
    return t;
}
function rowEl(cells, head) {
    const tr = document.createElement("tr");
    cells.forEach((c) => { const el = document.createElement(head ? "th" : "td"); el.textContent = c == null || c === "" ? "" : String(c); tr.appendChild(el); });
    return tr;
}
function num(v) { if (v == null || v === "") return null; const n = Number(String(v).replace(/[^\d.-]/g, "")); return isNaN(n) ? null : n; }
function vnd(v) { const n = num(v); return n == null ? "—" : n.toLocaleString("vi-VN") + " ₫"; }
