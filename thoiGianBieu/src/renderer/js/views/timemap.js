import * as api from "../api.js";
import { h, clear, DAY_VI, pad, todayISO } from "../ui.js";

const DAY_START = 6 * 60; // 06:00
const DAY_END = 22 * 60; // 22:00
let weekOffset = 0;

function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function fromMin(min) {
    return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
function mondayOf(offset) {
    const d = new Date(todayISO());
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    d.setDate(d.getDate() - dow + offset * 7);
    return d;
}

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn ghost small", onClick: () => { weekOffset--; render(container, ctx); } }, "← Tuần trước"),
        h("button", { class: "btn ghost small", onClick: () => { weekOffset = 0; render(container, ctx); } }, "Tuần này"),
        h("button", { class: "btn ghost small", onClick: () => { weekOffset++; render(container, ctx); } }, "Tuần sau →"),
    ]);

    clear(container);
    const [courses, exams, events] = await Promise.all([
        api.store.all("courses"),
        api.store.all("exams"),
        api.store.all("events"),
    ]);

    const monday = mondayOf(weekOffset);
    const weekLabel = `${pad(monday.getDate())}/${pad(monday.getMonth() + 1)}`;
    container.appendChild(h("div", { class: "note-box" }, [
        h("strong", { text: `Tuần bắt đầu ${weekLabel}. ` }),
        "Xanh dương = học trên trường, xanh lá = online, đỏ = thi, cam = AI đề xuất học/ôn, xám = nghỉ, và các khoảng TRỐNG có thể tận dụng.",
    ]));

    for (let i = 0; i < 7; i++) {
        const date = new Date(monday);
        date.setDate(monday.getDate() + i);
        const iso = todayISO(date);
        const dow = date.getDay();

        const slots = [];
        courses.filter((c) => Number(c.day) === dow).forEach((c) => {
            const s = toMin(c.start), e = toMin(c.end);
            slots.push({ s: s ?? 0, e: e ?? (s ?? 0) + 90, type: c.mode === "online" ? "online" : "fixed", title: c.name, sub: c.mode === "online" ? "Học online" : "Phòng " + (c.room || "?"), busy: true });
        });
        exams.filter((x) => x.date === iso).forEach((x) => {
            const s = toMin(x.session) ?? 8 * 60;
            slots.push({ s, e: s + 120, type: "exam", title: "THI: " + x.course, sub: x.room ? "Phòng " + x.room : "", busy: true });
        });
        events.filter((ev) => ev.date === iso).forEach((ev) => {
            const s = toMin(ev.start) ?? DAY_START, e = toMin(ev.end) ?? (s + 60);
            slots.push({ s, e, type: ev.type === "rest" ? "rest" : "study", title: ev.title, sub: ev.note || "", busy: ev.type !== "rest" ? false : false });
        });

        // Tinh khoang trong
        const busy = slots.filter((x) => x.type === "fixed" || x.type === "online" || x.type === "exam")
            .map((x) => [x.s, x.e]).sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const iv of busy) {
            if (merged.length && iv[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
            else merged.push([iv[0], iv[1]]);
        }
        const free = [];
        let cur = DAY_START;
        for (const [s, e] of merged) {
            if (s > cur) free.push([cur, s]);
            cur = Math.max(cur, e);
        }
        if (cur < DAY_END) free.push([cur, DAY_END]);
        free.filter(([s, e]) => e - s >= 60).forEach(([s, e]) => slots.push({ s, e, type: "free", title: "Thời gian trống", sub: "Có thể tự học / nghỉ", free: true }));

        slots.sort((a, b) => a.s - b.s);

        const dayCard = h("div", { class: "card timemap-day" }, [
            h("h4", { text: `${DAY_VI[dow]} — ${pad(date.getDate())}/${pad(date.getMonth() + 1)}${iso === todayISO() ? "  (hôm nay)" : ""}` }),
        ]);
        if (!slots.length) {
            dayCard.appendChild(h("div", { class: "muted small", text: "Cả ngày trống." }));
        } else {
            slots.forEach((s) => dayCard.appendChild(h("div", { class: "slot " + s.type }, [
                h("div", { class: "slot-time", text: `${fromMin(s.s)}–${fromMin(s.e)}` }),
                h("div", {}, [h("div", { text: s.title }), s.sub ? h("div", { class: "muted small", text: s.sub }) : ""]),
            ])));
        }
        container.appendChild(dayCard);
    }
}
