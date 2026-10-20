import * as api from "../api.js";
import { h, clear, fmtDateTime, toast, withButtonLoading } from "../ui.js";

const COL_LABEL = { courses: "môn (TKB)", assignments: "bài tập", exams: "lịch thi", grades: "điểm", tuition: "học phí", announcements: "thông báo", materials: "tài liệu" };
const SCOPE_LABEL = { profile: "Hồ sơ", courses: "Thời khóa biểu", exams: "Lịch thi", grades: "Điểm", tuition: "Học phí", assignments: "Bài tập", announcements: "Thông báo", materials: "Tài liệu" };
let unsub = null;

export async function render(container, ctx) {
    if (unsub) { unsub(); unsub = null; }
    ctx.setActions([]);
    clear(container);

    const [status, aiStatus] = await Promise.all([api.sync.status(), api.ai.status()]);

    container.appendChild(h("div", { class: "note-box" }, [
        h("strong", { text: "Đồng bộ thụ động. " }),
        "Chỉ cần chọn tài khoản Microsoft trong cửa sổ hiện ra. Đăng nhập xong, cửa sổ trình duyệt sẽ TỰ ĐÓNG và hệ thống cào dữ liệu ngầm (nhanh nhất có thể), gom về mục ",
        h("a", { href: "#records" }, "Tổng hợp học tập"),
        ". IU lấy thời khóa biểu, lịch thi, điểm; eLearning/LMS/EduX lấy bài tập, tài liệu. Không đụng tới trang đổi mật khẩu.",
    ]));

    if (!aiStatus.ready) {
        container.appendChild(h("div", { class: "warn-box", style: "margin-top:10px" }, [
            "Trợ lý AI cần sẵn sàng để tự phân tích dữ liệu. Hãy kiểm tra tại ", h("a", { href: "#settings" }, "Cài đặt"), ". Sau đó hệ thống sẽ tự đồng bộ.",
        ]));
    }

    // Trạng thái
    const statusText = h("span", {});
    const stageText = h("div", { class: "muted small", style: "margin-top:6px" });
    const lastSyncText = h("div", { class: "muted small", style: "margin-top:6px", text: status.lastSync ? "Đồng bộ gần nhất: " + fmtDateTime(status.lastSync) : "" });
    container.appendChild(h("div", { class: "card", style: "margin-top:14px" }, [
        h("div", { class: "card-head" }, [h("h3", { text: "Trạng thái" }), statusText]),
        stageText,
        lastSyncText,
        h("div", { class: "row", style: "margin-top:10px" }, [
            h("button", { class: "btn small primary", onClick: (e) => resyncNow(e.currentTarget) }, "Đồng bộ lại"),
        ]),
    ]));

    // Đồng bộ lại thủ công: cào lại dữ liệu mới nhất (mở lại phiên nếu cần).
    async function resyncNow(btn) {
        await withButtonLoading(btn, async () => {
            clear(logBody);
            stageText.textContent = "Đang đồng bộ lại…";
            const r = await api.sync.resync();
            if (r && r.ok === false) { toast(r.message || "Đang bận, thử lại sau.", "warn"); stageText.textContent = r.message || ""; }
        });
    }

    function setLogin(state) {
        if (state === "logged-in" || (state === undefined && status.loggedIn)) { statusText.className = "badge green"; statusText.textContent = "Đã đăng nhập"; }
        else if (state === "logging-in") { statusText.className = "badge orange"; statusText.textContent = "Đang đăng nhập…"; }
        else { statusText.className = "badge gray"; statusText.textContent = "Chưa đăng nhập"; }
    }
    setLogin();

    // Tiến trình cào
    const log = h("div", { class: "card", style: "margin-top:14px; display:none" });
    const logBody = h("div", { style: "max-height:280px; overflow-y:auto" });
    log.append(h("div", { class: "card-head" }, [h("h3", { text: "Tiến trình cào dữ liệu" }), h("a", { href: "#records", class: "small" }, "Xem tổng hợp →")]), logBody);
    container.appendChild(log);
    function appendLog(msg) {
        log.style.display = "";
        logBody.appendChild(h("div", { class: "small", style: "padding:3px 0", text: msg }));
        logBody.scrollTop = logBody.scrollHeight;
    }

    // Danh sách 4 hệ thống (chỉ thông tin)
    container.appendChild(h("div", { class: "section-title", text: "Các hệ thống & dữ liệu sẽ cào" }));
    const grid = h("div", { class: "grid cols-2" });
    status.portals.forEach((p) => grid.appendChild(h("div", { class: "card" }, [
        h("div", { class: "item-title", text: p.name }),
        h("div", { class: "muted small", text: p.url }),
        h("div", { class: "row wrap", style: "gap:6px;margin-top:8px" }, (p.scope || []).map((s) => h("span", { class: "badge blue", text: SCOPE_LABEL[s] || s }))),
    ])));
    container.appendChild(grid);

    // Lắng nghe tiến trình
    unsub = api.on("sync:progress", (p) => {
        if (!p) return;
        if (p.type === "cmc") {
            if (p.stage === "logged-in") setLogin("logged-in");
            else if (p.stage === "logging-in") setLogin("logging-in");
        } else if (p.type === "crawl") {
            const name = p.name || p.portal || "";
            if (p.stage === "all-start") { clear(logBody); appendLog("Bắt đầu cào toàn bộ…"); stageText.textContent = "Đang cào dữ liệu…"; }
            else if (p.stage === "opening") appendLog(`Đang mở ${name}…`);
            else if (p.stage === "authing") appendLog(`Đang đăng nhập ${name} qua Microsoft…`);
            else if (p.stage === "account") appendLog(`Tài khoản: ${p.email || ""}${p.mssv ? " (MSSV " + p.mssv + ")" : ""} — lưu dữ liệu riêng cho tài khoản này.`);
            else if (p.stage === "crawling") appendLog(`Đang cào ${name}${p.total ? ` (trang ${p.visited}/${p.total})` : "…"}`);
            else if (p.stage === "analyzing") appendLog(`AI đang phân tích ${name}…`);
            else if (p.stage === "retry") appendLog(`Chưa có dữ liệu, thử lại ${name} (chờ lâu hơn)…`);
            else if (p.stage === "done") appendLog(`✓ Xong ${name}: ${summaryCounts(p.counts)}${statsStr(p.stats)}`);
            else if (p.stage === "error") appendLog(`✗ ${name}: ${p.message || ""}${statsStr(p.stats)}`);
            else if (p.stage === "need-ai") { appendLog("Trợ lý AI chưa sẵn sàng — hãy kiểm tra tại Cài đặt rồi thử lại."); stageText.textContent = "Đang chờ dịch vụ AI."; }
            else if (p.stage === "all-done") { appendLog(`Hoàn tất (tổng ${p.totalExtracted || 0} mục). Xem mục Tổng hợp học tập.`); stageText.textContent = "Đã cào xong."; }
        }
    });

    // TỰ ĐỘNG khởi động: mở đăng nhập nếu cần, rồi tự cào (không cần bấm nút).
    try {
        const r = await api.sync.autoStart();
        if (r.opened) stageText.textContent = status.loggedIn ? "Đang đồng bộ ngầm…" : "Đang mở cửa sổ đăng nhập Microsoft… (chọn tài khoản xong sẽ tự ẩn và cào ngầm)";
        else if (r.crawling) stageText.textContent = "Đang cào dữ liệu…";
    } catch (e) {
        stageText.textContent = "Lỗi khởi động: " + (e.message || e);
    }
}

function summaryCounts(counts) {
    if (!counts) return "không có dữ liệu";
    const parts = [];
    for (const [k, v] of Object.entries(counts)) if (v) parts.push(`${v} ${COL_LABEL[k] || k}`);
    return parts.length ? parts.join(", ") : "không có mục mới";
}
function statsStr(stats) {
    if (!stats) return "";
    return `  [bắt: ${stats.pages || 0} trang, ${stats.api || 0} API, ${stats.decrypted || 0} khối dữ liệu]`;
}
