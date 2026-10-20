import * as api from "../api.js";
import { h, clear, toast, modal, confirmModal, withButtonLoading } from "../ui.js";

export async function render(container, ctx) {
    ctx.setActions([]);
    clear(container);
    const s = await api.settings.get();
    let dataDirText = "";
    try { dataDirText = (await api.data.info()).dir || ""; } catch { dataDirText = "(Khởi động lại app để dùng phần này)"; }

    // ===== Tài khoản dữ liệu đang xem =====
    const acc = s.student || {};
    container.appendChild(card("Tài khoản dữ liệu", [
        h("div", { class: "note-box", text: "Dữ liệu được lưu RIÊNG cho từng tài khoản (folder theo email sinh viên, định danh bằng MSSV). Đăng nhập tài khoản khác sẽ có dữ liệu riêng, không bị lẫn." }),
        h("div", { class: "grid cols-3", style: "margin-top:8px" }, [
            infoCell("Sinh viên", acc.name), infoCell("MSSV", acc.mssv), infoCell("Email", acc.email),
        ]),
        (!acc.mssv && !acc.email) ? h("div", { class: "muted small", style: "margin-top:6px", text: "Chưa xác định tài khoản — hãy Đồng bộ portal để cào hồ sơ (#hoso)." }) : "",
    ]));

    // ===== Sinh vien =====
    const stName = h("input", { value: (s.student && s.student.name) || "", placeholder: "Họ và tên" });
    const stMssv = h("input", { value: (s.student && s.student.mssv) || "", placeholder: "Mã số sinh viên" });
    const stEmail = h("input", { value: (s.student && s.student.email) || "", placeholder: "Email sinh viên" });
    container.appendChild(card("Thông tin sinh viên", [
        h("div", { class: "inline-form" }, [
            field("Họ tên", stName), field("MSSV", stMssv), field("Email", stEmail),
        ]),
        saveRow(async (btn) => {
            await withButtonLoading(btn, async () => {
                await api.settings.set({ student: { name: stName.value.trim(), mssv: stMssv.value.trim(), email: stEmail.value.trim() } });
                toast("Đã lưu thông tin sinh viên", "ok");
            });
        }),
    ]));

    // ===== Trợ lý AI: bật sẵn, không cần cấu hình =====
    const aiBadge = h("span", { class: "badge green", text: "Sẵn sàng" });

    const aiCard = card("Trợ lý AI", [
        h("div", { class: "row", style: "margin:-4px 0 12px" }, [h("span", { class: "muted small", text: "Trạng thái:" }), aiBadge]),
        h("div", { class: "note-box", style: "margin-bottom:12px", text: "Trợ lý AI được bật tự động — không cần đăng nhập, API key hay cấu hình thêm. Bạn có thể sử dụng ngay khi mở ứng dụng." }),
        h("div", { class: "row wrap" }, [
            h("button", { class: "btn ghost", onClick: (e) => testAi(e.currentTarget) }, "Kiểm tra AI"),
        ]),
    ]);
    container.appendChild(aiCard);

    async function testAi(btn) {
        await withButtonLoading(btn, async () => {
            const out = await api.ai.ask("Trả lời đúng một từ: OK");
            toast("AI phản hồi: " + out.slice(0, 40), "ok", "Kiểm tra thành công");
        });
    }

    // ===== Email =====
    const mailService = h("select", {}, [
        h("option", { value: "gmail", selected: (s.mail && s.mail.service) !== "custom" }, "Gmail"),
        h("option", { value: "custom", selected: (s.mail && s.mail.service) === "custom" }, "SMTP tuỳ chỉnh"),
    ]);
    const mailUser = h("input", { value: (s.mail && s.mail.user) || "", placeholder: "email@gmail.com" });
    const mailPass = h("input", { type: "password", value: (s.mail && s.mail.pass) || "", placeholder: "App Password (16 ký tự)" });
    const mailHost = h("input", { value: (s.mail && s.mail.host) || "", placeholder: "smtp.example.com" });
    const mailPort = h("input", { type: "number", value: (s.mail && s.mail.port) || 465 });

    container.appendChild(card("Email (để gửi đơn xin nghỉ)", [
        h("div", { class: "note-box", style: "margin-bottom:12px" }, [
            "Với Gmail: bật 2 bước xác minh rồi tạo ",
            h("a", { href: "https://myaccount.google.com/apppasswords", target: "_blank" }, "App Password"),
            " và dán vào ô mật khẩu (không dùng mật khẩu đăng nhập thường).",
        ]),
        field("Dịch vụ", mailService),
        h("div", { class: "inline-form" }, [field("Email gửi", mailUser), field("App Password", mailPass)]),
        h("div", { class: "inline-form" }, [field("SMTP host (nếu tuỳ chỉnh)", mailHost), field("Port", mailPort)]),
        h("div", { class: "row wrap" }, [
            h("button", { class: "btn primary", onClick: (e) => saveMail(e.currentTarget) }, "Lưu email"),
            h("button", { class: "btn ghost", onClick: (e) => testMail(e.currentTarget) }, "Kiểm tra kết nối"),
        ]),
    ]));

    async function saveMail(btn) {
        await withButtonLoading(btn, async () => {
            await api.settings.set({ mail: { service: mailService.value, user: mailUser.value.trim(), pass: mailPass.value, host: mailHost.value.trim(), port: Number(mailPort.value) || 465, secure: (Number(mailPort.value) || 465) === 465 } });
            toast("Đã lưu cấu hình email", "ok");
        });
    }
    async function testMail(btn) {
        await withButtonLoading(btn, async () => {
            await api.settings.set({ mail: { service: mailService.value, user: mailUser.value.trim(), pass: mailPass.value, host: mailHost.value.trim(), port: Number(mailPort.value) || 465, secure: (Number(mailPort.value) || 465) === 465 } });
            await api.mail.verify();
            toast("Kết nối email OK", "ok", "Thành công");
        });
    }

    // ===== Du lieu =====
    const collections = [
        ["courses", "Thời khóa biểu"], ["assignments", "Bài tập"], ["exams", "Lịch thi"],
        ["events", "Sự kiện/lịch tự thêm"], ["documents", "Tài liệu"], ["textbook", "Ghi chú"], ["reminders", "Nhắc nhở"],
    ];
    container.appendChild(card("Dữ liệu cục bộ", [
        h("p", { class: "muted small", text: "Toàn bộ dữ liệu lưu trên máy bạn (không có server). Bạn có thể xoá từng nhóm dữ liệu." }),
        h("div", { class: "row wrap" }, collections.map(([key, label]) =>
            h("button", { class: "btn small danger", onClick: async () => {
                if (await confirmModal(`Xoá toàn bộ "${label}"? Không thể hoàn tác.`)) { await api.store.clear(key); toast(`Đã xoá ${label}`, "ok"); ctx.refreshBadges(); }
            } }, "Xoá " + label)
        )),
    ]));

    // ===== Thư mục dữ liệu (JSON cạnh app) — dễ dọn dẹp / đóng gói gửi =====
    container.appendChild(card("Thư mục dữ liệu & xoá sạch", [
        h("div", { class: "note-box", text: "Mọi dữ liệu (ghi chú, thời khóa biểu, lịch thi… + phiên đăng nhập) được lưu trong THƯ MỤC NGƯỜI DÙNG của máy — KHÔNG nằm trong project. Vì vậy chép/gửi app đi nơi khác sẽ không mang theo dữ liệu; máy nào chưa có dữ liệu thì coi như app mới hoàn toàn. Bấm nút dưới để mở đúng thư mục hoặc xoá sạch." }),
        h("div", { class: "muted small", style: "margin:10px 0; word-break:break-all", text: dataDirText }),
        h("div", { class: "row wrap" }, [
            h("button", { class: "btn", onClick: (e) => openData(e.currentTarget) }, "📂 Mở thư mục dữ liệu"),
            h("button", { class: "btn danger", onClick: (e) => wipeAllData(e.currentTarget) }, "Xoá TOÀN BỘ dữ liệu"),
        ]),
    ]));

    async function openData(btn) {
        await withButtonLoading(btn, async () => { await api.data.openFolder(); });
    }
    async function wipeAllData(btn) {
        const ok = await confirmModal(
            "Xoá TOÀN BỘ dữ liệu? Gồm mọi tài khoản, ghi chú, thời khóa biểu, lịch thi, điểm, cấu hình và phiên đăng nhập. KHÔNG THỂ HOÀN TÁC.",
            "Xoá sạch dữ liệu"
        );
        if (!ok) return;
        try {
            await withButtonLoading(btn, () => api.data.wipeAll());
        } catch { return; /* withButtonLoading đã toast lỗi */ }
        toast("Đã xoá toàn bộ dữ liệu. Nên khởi động lại app để bắt đầu hoàn toàn sạch.", "ok", "Đã xoá sạch");
        ctx.refreshBadges();
        ctx.refreshAiBadge();
        await render(container, ctx);
    }

    // ===== Đăng xuất portal =====
    container.appendChild(card("Đăng xuất khỏi portal", [
        h("p", { class: "muted small", text: "Đăng xuất khỏi tài khoản Microsoft/portal CMC (xoá phiên đăng nhập trên máy). Lần sau đồng bộ sẽ cần đăng nhập lại. Cấu hình email vẫn được giữ." }),
        h("div", { class: "row wrap" }, [
            h("button", { class: "btn danger", onClick: (e) => doLogout(e.currentTarget) }, "Đăng xuất"),
        ]),
    ]));

    async function doLogout(btn) {
        // Hỏi có xoá dữ liệu học tập không: có thì xoá, không thì chỉ đăng xuất (giữ dữ liệu).
        const wipeChk = h("input", { type: "checkbox" });
        const choice = await new Promise((resolve) => {
            modal({
                title: "Đăng xuất khỏi portal",
                body: h("div", {}, [
                    h("p", { text: "Bạn sẽ được đăng xuất khỏi portal CMC. Phiên đăng nhập Microsoft trên máy sẽ bị xoá." }),
                    h("label", { class: "row", style: "gap:8px; align-items:flex-start; margin-top:10px; cursor:pointer" }, [
                        wipeChk,
                        h("span", { text: "Xoá luôn dữ liệu học tập đã tải về máy (thời khóa biểu, lịch thi, điểm, học phí, hồ sơ...). Không thể hoàn tác." }),
                    ]),
                    h("p", { class: "muted small", style: "margin-top:8px", text: "Bỏ trống ô trên nếu chỉ muốn đăng xuất mà vẫn giữ dữ liệu." }),
                ]),
                actions: [
                    { label: "Huỷ", variant: "ghost", onClick: (close) => { close(); resolve(null); } },
                    { label: "Đăng xuất", variant: "danger", onClick: (close) => { const wipe = wipeChk.checked; close(); resolve({ wipe }); } },
                ],
            });
        });
        if (!choice) return;

        try {
            await withButtonLoading(btn, () => api.sync.logout(choice.wipe));
        } catch {
            return; // withButtonLoading đã toast lỗi
        }
        toast(choice.wipe ? "Đã đăng xuất và xoá dữ liệu học tập." : "Đã đăng xuất khỏi portal.", "ok");
        ctx.refreshBadges();
        if (choice.wipe) await render(container, ctx); // vẽ lại để cập nhật hồ sơ đã trống
    }
}

function card(title, children) {
    return h("div", { class: "card", style: "margin-bottom:16px" }, [h("h3", { text: title }), ...children]);
}
function infoCell(label, val) {
    return h("div", { style: "margin-bottom:6px" }, [h("div", { class: "muted small", text: label }), h("div", { text: val || "—" })]);
}
function field(label, node) {
    return h("label", { class: "field" }, [h("span", { text: label }), node]);
}
function saveRow(onClick) {
    return h("div", { class: "row" }, [h("button", { class: "btn primary", onClick: (e) => onClick(e.currentTarget) }, "Lưu")]);
}
