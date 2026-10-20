// Tien ich UI dung chung: tao element, toast, modal, dinh dang ngay gio.

export const DAY_VI = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
export const DAY_SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

export function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "text") el.textContent = v;
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "value") el.value = v;
        else if (k === "checked" || k === "disabled" || k === "selected") { if (v) el.setAttribute(k, ""); }
        else el.setAttribute(k, v);
    }
    const kids = Array.isArray(children) ? children : [children];
    for (const c of kids) {
        if (c == null || c === false) continue;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
}

export function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
}

export function escapeHtml(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ===== Toast =====
export function toast(message, type = "ok", title = "") {
    const host = document.getElementById("toast-host");
    const node = h("div", { class: `toast ${type}` }, [
        title ? h("div", { class: "t-title", text: title }) : null,
        h("div", { class: "t-body", text: message }),
    ]);
    host.appendChild(node);
    setTimeout(() => {
        node.style.opacity = "0";
        node.style.transition = "opacity .3s";
        setTimeout(() => node.remove(), 300);
    }, type === "error" ? 6000 : 3500);
}

// ===== Modal =====
export function modal({ title, body, actions }) {
    const host = document.getElementById("modal-host");
    clear(host);
    const close = () => { host.classList.remove("show"); clear(host); };

    const footer = h("div", { class: "modal-foot" });
    (actions || [{ label: "Đóng", onClick: close }]).forEach((a) => {
        footer.appendChild(
            h("button", { class: `btn ${a.variant || "ghost"}`, onClick: () => a.onClick && a.onClick(close) }, a.label)
        );
    });

    const bodyNode = typeof body === "string" ? h("div", { html: body }) : body;
    const box = h("div", { class: "modal" }, [
        h("div", { class: "modal-head", text: title || "" }),
        h("div", { class: "modal-body" }, bodyNode),
        footer,
    ]);
    host.appendChild(box);
    host.classList.add("show");
    host.onclick = (e) => { if (e.target === host) close(); };
    return { close, box };
}

export function confirmModal(message, title = "Xác nhận") {
    return new Promise((resolve) => {
        modal({
            title,
            body: h("div", { text: message }),
            actions: [
                { label: "Huỷ", variant: "ghost", onClick: (close) => { close(); resolve(false); } },
                { label: "Đồng ý", variant: "primary", onClick: (close) => { close(); resolve(true); } },
            ],
        });
    });
}

// ===== Dinh dang =====
export function pad(n) { return String(n).padStart(2, "0"); }

export function todayISO(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
    if (isNaN(d)) return iso;
    return `${DAY_VI[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function fmtDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function daysUntil(iso) {
    if (!iso) return null;
    const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
    if (isNaN(d)) return null;
    const today = new Date(todayISO());
    return Math.round((new Date(todayISO(d)) - today) / 86400000);
}

export function deadlineBadge(iso) {
    const d = daysUntil(iso);
    if (d == null) return { cls: "gray", text: "Không hạn" };
    if (d < 0) return { cls: "red", text: `Trễ ${Math.abs(d)} ngày` };
    if (d === 0) return { cls: "orange", text: "Hôm nay" };
    if (d === 1) return { cls: "orange", text: "Ngày mai" };
    if (d <= 3) return { cls: "orange", text: `Còn ${d} ngày` };
    return { cls: "green", text: `Còn ${d} ngày` };
}

// Bao boc mot hanh dong async: hien spinner tren nut, bat loi -> toast.
export async function withButtonLoading(btn, fn) {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Đang xử lý…';
    try {
        return await fn();
    } catch (err) {
        toast(err.message || String(err), "error", "Lỗi");
        throw err;
    } finally {
        btn.disabled = false;
        btn.innerHTML = old;
    }
}
