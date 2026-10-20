import * as api from "../api.js";
import { h, clear, toast } from "../ui.js";

let mode = "explain"; // explain | check
const log = []; // {role, text}

export async function render(container, ctx) {
    ctx.setActions([
        h("button", { class: "btn ghost small", onClick: async () => { log.length = 0; drawLog(logHost); try { await api.ai.resetChat(); } catch { /* ignore */ } } }, "Xoá hội thoại"),
    ]);
    clear(container);

    const status = await api.ai.status();
    if (!status.ready) {
        container.appendChild(h("div", { class: "warn-box" }, ["Trợ lý AI chưa sẵn sàng. Hãy kiểm tra lại tại ", h("a", { href: "#settings" }, "Cài đặt"), "."]));
    }

    const modeBar = h("div", { class: "row wrap", style: "margin-bottom:10px" }, [
        modeBtn("explain", "Giải thích / Hỏi đáp"),
        modeBtn("check", "Kiểm chứng nhận định"),
        h("span", { class: "muted small", style: "margin-left:8px", text: mode === "explain" ? "AI giải thích kiến thức, dùng cả tài liệu & ghi chú của bạn." : "AI đánh giá nhận định của bạn Đúng / Sai / Đúng một phần." }),
    ]);
    container.appendChild(modeBar);

    const chat = h("div", { class: "chat" });
    const logHost = h("div", { class: "chat-log" });
    const input = h("textarea", {
        placeholder: mode === "explain" ? "VD: Giải thích con trỏ trong C++ (Enter 2 lần để gửi)" : 'VD: "Binary Search có độ phức tạp O(n)" (Enter 2 lần để gửi)',
        onkeydown: (e) => {
            if (e.isComposing) return; // đang gõ tiếng Việt qua bộ gõ -> bỏ qua
            if (e.key !== "Enter" || e.shiftKey) return; // Shift+Enter: luôn xuống dòng
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); send(); return; } // Ctrl/Cmd+Enter: gửi ngay
            // Enter 2 lần liên tiếp (ngay trước con trỏ đã là dòng trống) -> gửi.
            const el = e.currentTarget;
            if (/\n[ \t]*$/.test(el.value.slice(0, el.selectionStart))) { e.preventDefault(); send(); }
            // Enter đơn: để xuống dòng bình thường.
        },
    });
    const sendBtn = h("button", { class: "btn primary", onClick: () => send() }, "Gửi");
    chat.appendChild(logHost);
    chat.appendChild(h("div", { class: "chat-input" }, [input, sendBtn]));
    container.appendChild(chat);

    function modeBtn(key, label) {
        return h("button", { class: "btn small " + (mode === key ? "primary" : "ghost"), onClick: () => { mode = key; render(container, ctx); } }, label);
    }

    drawLog(logHost);

    async function send() {
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        // Ngữ cảnh hội thoại: các lượt ĐÃ hoàn tất trước đó -> AI nhớ mạch chat, không tạo cuộc trò chuyện mới mỗi lần.
        const history = log
            .filter((m) => !m.pending && !m.error && m.text && m.text !== "…")
            .map((m) => ({ role: m.role === "user" ? "user" : "model", text: m.text }));
        log.push({ role: "user", text });
        drawLog(logHost);

        const thinking = { role: "ai", text: "…", pending: true };
        log.push(thinking);
        drawLog(logHost);

        try {
            const answer = mode === "check" ? await api.ai.checkKnowledge(text) : await api.ai.explain(text, history);
            thinking.text = answer;
            thinking.pending = false;
        } catch (err) {
            thinking.text = "Lỗi: " + (err.message || err);
            thinking.pending = false;
            thinking.error = true;
            toast(err.message || "Lỗi gọi AI", "error");
        }
        drawLog(logHost);
    }

    function drawLog(host) {
        clear(host);
        if (!log.length) {
            host.appendChild(h("div", { class: "msg sys", text: "Bắt đầu hỏi trợ lý AI. Nhấn Enter 2 lần (hoặc Ctrl+Enter) để gửi." }));
        }
        log.forEach((m) => {
            const node = h("div", { class: "msg " + (m.role === "user" ? "user" : "ai") });
            if (m.pending) node.appendChild(h("span", { class: "loading-inline" }, [h("span", { class: "spinner" }), "Đang trả lời…"]));
            else node.textContent = m.text;
            host.appendChild(node);
        });
        host.scrollTop = host.scrollHeight;
    }
}
