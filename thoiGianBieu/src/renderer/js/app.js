import * as api from "./api.js";
import { h, clear, toast } from "./ui.js";

import * as dashboard from "./views/dashboard.js";
import * as records from "./views/records.js";
import * as timetable from "./views/timetable.js";
import * as assignments from "./views/assignments.js";
import * as exams from "./views/exams.js";
import * as timemap from "./views/timemap.js";
import * as planner from "./views/planner.js";
import * as assistant from "./views/assistant.js";
import * as documents from "./views/documents.js";
import * as textbook from "./views/textbook.js";
import * as reminders from "./views/reminders.js";
import * as leave from "./views/leave.js";
import * as mailbox from "./views/mailbox.js";
import * as syncView from "./views/sync.js";
import * as settings from "./views/settings.js";

const ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    records: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    timetable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    assignments: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
    exams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4L12 17l-6.3 4.4L8 14 2 9.4h7.6z"/></svg>',
    timemap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    planner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M5 8l2 2M19 8l-2 2"/><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M9 15h6"/></svg>',
    assistant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    documents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    textbook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    reminders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M22 6l-10 7L2 6"/></svg>',
    mailbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M22 7l-10 6L2 7"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-9 9c-2.5 0-4.7-1-6.3-2.6M3 12a9 9 0 0 1 9-9c2.5 0 4.7 1 6.3 2.6"/><path d="M21 3v6h-6M3 21v-6h6"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6h.1A1.6 1.6 0 0 0 8 1.1V1a2 2 0 0 1 4 0v.1A1.6 1.6 0 0 0 15 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>',
};

const VIEWS = {
    dashboard: { label: "Trang chủ", group: "Tổng quan", mod: dashboard },
    records: { label: "Tổng hợp học tập", group: "Tổng quan", mod: records },
    timetable: { label: "Thời khóa biểu", group: "Học tập", mod: timetable },
    assignments: { label: "Bài tập & To-do", group: "Học tập", mod: assignments, badge: "assignments" },
    exams: { label: "Lịch thi", group: "Học tập", mod: exams },
    timemap: { label: "Bản đồ thời gian", group: "Học tập", mod: timemap },
    planner: { label: "AI lập lịch", group: "Trí tuệ nhân tạo", mod: planner },
    assistant: { label: "Trợ lý AI", group: "Trí tuệ nhân tạo", mod: assistant },
    documents: { label: "Tài liệu", group: "Cá nhân", mod: documents },
    textbook: { label: "Textbook", group: "Cá nhân", mod: textbook },
    reminders: { label: "Nhắc nhở", group: "Cá nhân", mod: reminders },
    leave: { label: "Xin nghỉ học", group: "Cá nhân", mod: leave },
    mailbox: { label: "Hộp thư", group: "Cá nhân", mod: mailbox },
    sync: { label: "Đồng bộ portal", group: "Hệ thống", mod: syncView },
    settings: { label: "Cài đặt", group: "Hệ thống", mod: settings },
};

const DEFAULT_ROUTE = "dashboard";
let currentKey = null;

function buildNav() {
    const nav = document.getElementById("nav");
    clear(nav);
    const groups = {};
    for (const [key, v] of Object.entries(VIEWS)) {
        (groups[v.group] = groups[v.group] || []).push([key, v]);
    }
    for (const [group, items] of Object.entries(groups)) {
        nav.appendChild(h("div", { class: "nav-group", text: group }));
        for (const [key, v] of items) {
            const item = h("a", {
                class: "nav-item",
                href: `#${key}`,
                dataset: { key },
            }, [
                h("span", { class: "icon", html: ICONS[key] || "" }),
                h("span", { text: v.label }),
                v.badge ? h("span", { class: "count", dataset: { badge: v.badge }, text: "" }) : null,
            ]);
            nav.appendChild(item);
        }
    }
}

function setActiveNav(key) {
    document.querySelectorAll(".nav-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.key === key);
    });
}

// Context truyen cho moi view.
function makeCtx() {
    return {
        setTitle: (t) => { document.getElementById("page-title").textContent = t; },
        setActions: (nodes) => {
            const host = document.getElementById("topbar-actions");
            clear(host);
            (nodes || []).forEach((n) => host.appendChild(n));
        },
        navigate: (key) => { location.hash = "#" + key; },
        refreshBadges,
        refreshAiBadge,
    };
}

async function renderRoute() {
    const key = (location.hash || "#" + DEFAULT_ROUTE).slice(1).split("?")[0];
    const view = VIEWS[key] || VIEWS[DEFAULT_ROUTE];
    currentKey = VIEWS[key] ? key : DEFAULT_ROUTE;
    setActiveNav(currentKey);

    const ctx = makeCtx();
    ctx.setTitle(view.label);
    ctx.setActions([]);
    const container = document.getElementById("view");
    clear(container);
    container.appendChild(h("div", { class: "loading-inline" }, [h("span", { class: "spinner" }), "Đang tải…"]));

    try {
        clear(container);
        await view.mod.render(container, ctx);
    } catch (err) {
        clear(container);
        container.appendChild(h("div", { class: "warn-box", text: "Lỗi khi hiển thị: " + (err.message || err) }));
        // eslint-disable-next-line no-console
        console.error(err);
    }
}

async function refreshBadges() {
    try {
        const asg = await api.store.all("assignments");
        const pending = asg.filter((a) => !a.done).length;
        document.querySelectorAll('[data-badge="assignments"]').forEach((el) => {
            el.textContent = pending ? String(pending) : "";
            el.style.display = pending ? "" : "none";
        });
    } catch { /* ignore */ }
}

async function refreshAiBadge() {
    const badge = document.getElementById("ai-badge");
    try {
        const s = await api.ai.status();
        if (s.ready) {
            badge.className = "ai-badge ok";
            badge.textContent = "AI sẵn sàng";
        } else {
            badge.className = "ai-badge bad";
            badge.textContent = "AI chưa sẵn sàng";
        }
    } catch {
        badge.className = "ai-badge bad";
        badge.textContent = "AI: không kiểm tra được";
    }
}

function initReminders() {
    api.on("reminder:fired", (payload) => {
        toast(payload.body || "", "warn", payload.title || "Nhắc nhở");
        refreshBadges();
        if (currentKey === "dashboard") renderRoute();
    });
    // Khi phiên AI được tự nạp lúc khởi động -> cập nhật lại trạng thái.
    api.on("ai:updated", () => refreshAiBadge());
}

function boot() {
    buildNav();
    window.addEventListener("hashchange", renderRoute);
    initReminders();
    refreshAiBadge();
    refreshBadges();
    if (!location.hash) location.hash = "#" + DEFAULT_ROUTE;
    renderRoute();
}

boot();
