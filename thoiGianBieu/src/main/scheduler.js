"use strict";

/**
 * Bộ lập lịch nhắc nhở chạy nền trong main process.
 * Mỗi phút quét:
 *   - reminders: nhắc tuỳ chỉnh theo mốc thời gian
 *   - courses:   nhắc trước giờ học N phút (mặc định 15')
 *   - assignments: nhắc trước deadline (1 ngày & trong ngày)
 *   - exams:     đếm ngược (7 / 3 / 1 ngày)
 * Trạng thái đã-nhắc được lưu ra file để không nhắc lại sau khi khởi động lại.
 */

const fs = require("fs");
const path = require("path");
const store = require("./store");

const DAY_MS = 86400000;

function pad(n) {
    return String(n).padStart(2, "0");
}
function todayISO(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function minutesOfDay(d = new Date()) {
    return d.getHours() * 60 + d.getMinutes();
}
function hhmmToMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

class Scheduler {
    constructor({ onFire, intervalMs } = {}) {
        this.onFire = typeof onFire === "function" ? onFire : () => {};
        this.intervalMs = intervalMs || 60 * 1000;
        this.timer = null;
        this.stateFile = path.join(store.getDataDir() || ".", "reminder-state.json");
        this.fired = this._loadState();
    }

    _loadState() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
            return new Set(Array.isArray(parsed.fired) ? parsed.fired : []);
        } catch {
            return new Set();
        }
    }

    _saveState() {
        try {
            // Giữ gọn: chỉ lưu tối đa 500 khoá gần nhất.
            const arr = Array.from(this.fired).slice(-500);
            fs.writeFileSync(this.stateFile, JSON.stringify({ fired: arr }, null, 2), "utf8");
        } catch {
            /* ignore */
        }
    }

    _mark(key) {
        this.fired.add(key);
        this._saveState();
    }

    start() {
        if (this.timer) return;
        // Chạy ngay 1 lần rồi lặp lại.
        this.tick();
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    tick() {
        try {
            const settings = store.getSettings();
            const lead = (settings.reminders && settings.reminders.classLeadMinutes) || 15;
            const now = new Date();
            this._checkReminders(now);
            this._checkCourses(now, lead);
            this._checkAssignments(now);
            this._checkExams(now);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[scheduler] tick error:", err && err.message);
        }
    }

    _fire(key, title, body, meta) {
        if (this.fired.has(key)) return;
        this._mark(key);
        this.onFire({ key, title, body, meta: meta || {} });
    }

    _checkReminders(now) {
        for (const r of store.all("reminders")) {
            if (r.fired) continue;
            const t = new Date(r.time || 0).getTime();
            if (!t) continue;
            if (t <= now.getTime()) {
                this._fire(`reminder:${r.id}`, r.title || "Nhắc nhở", r.note || "", { type: "reminder", id: r.id });
                store.update("reminders", r.id, { fired: true });
            }
        }
    }

    _checkCourses(now, lead) {
        const dow = now.getDay();
        const cur = minutesOfDay(now);
        const dateKey = todayISO(now);
        for (const c of store.all("courses")) {
            if (Number(c.day) !== dow) continue;
            const startMin = hhmmToMinutes(c.start);
            if (startMin == null) continue;
            const diff = startMin - cur;
            if (diff >= 0 && diff <= lead) {
                const where = c.mode === "online" ? "học ONLINE" : `phòng ${c.room || "?"}`;
                this._fire(
                    `course:${c.id}:${dateKey}`,
                    `Sắp tới giờ học: ${c.name}`,
                    `${diff <= 0 ? "Bắt đầu ngay" : `Còn ${diff} phút`} - ${c.start} (${where}).`,
                    { type: "course", id: c.id }
                );
            }
        }
    }

    _checkAssignments(now) {
        const today = todayISO(now);
        for (const a of store.all("assignments")) {
            if (a.done || !a.deadline) continue;
            const dl = new Date(a.deadline);
            if (isNaN(dl)) continue;
            const dlDate = todayISO(dl);
            const daysLeft = Math.round((new Date(dlDate) - new Date(today)) / DAY_MS);
            if (daysLeft === 1) {
                this._fire(`asg:${a.id}:d1`, `Còn 1 ngày: ${a.title}`, `Bài tập môn ${a.course || ""} sắp tới hạn (${a.deadline}).`, { type: "assignment", id: a.id });
            } else if (daysLeft === 0) {
                this._fire(`asg:${a.id}:d0`, `Hết hạn hôm nay: ${a.title}`, `Bài tập môn ${a.course || ""} tới hạn hôm nay. Hoàn thành sớm nhé!`, { type: "assignment", id: a.id });
            }
        }
    }

    _checkExams(now) {
        const today = todayISO(now);
        for (const e of store.all("exams")) {
            if (!e.date) continue;
            const daysLeft = Math.round((new Date(e.date) - new Date(today)) / DAY_MS);
            for (const milestone of [7, 3, 1]) {
                if (daysLeft === milestone) {
                    this._fire(
                        `exam:${e.id}:d${milestone}`,
                        `Còn ${milestone} ngày thi: ${e.course}`,
                        `Lịch thi ngày ${e.date}${e.session ? ` (ca ${e.session})` : ""}${e.room ? `, phòng ${e.room}` : ""}.`,
                        { type: "exam", id: e.id }
                    );
                }
            }
        }
    }
}

module.exports = { Scheduler };
