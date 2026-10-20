import * as api from "../api.js";
import { h, clear, toast, confirmModal, todayISO, withButtonLoading } from "../ui.js";

// Các loại lý do -> AI soạn văn phong phù hợp từng loại.
const REASON_TYPES = [
    ["sick", "Ốm / bệnh"],
    ["family", "Việc gia đình"],
    ["personal", "Việc cá nhân"],
    ["event", "Hoạt động / sự kiện"],
    ["accident", "Sự cố (kẹt xe, hỏng xe…)"],
    ["other", "Khác"],
];

const keyFor = (lecturer, courseName) => String(lecturer || courseName || "").trim().toLowerCase();

export async function render(container, ctx) {
    ctx.setActions([]);
    clear(container);

    const [courses, settings, aiStatus] = await Promise.all([
        api.store.all("courses"),
        api.settings.get(),
        api.ai.status(),
    ]);

    const student = settings.student || {};
    const emailBook = (student.lecturerEmails && typeof student.lecturerEmails === "object") ? { ...student.lecturerEmails } : {};
    const mailConfigured = !!(settings.mail && settings.mail.user && settings.mail.pass);

    container.appendChild(h("div", { class: "note-box", text: "Soạn đơn xin phép nghỉ học đúng form (có MSSV, tên, kính gửi giảng viên, lý do, cam kết) rồi gửi bằng CHÍNH email trường qua Outlook. Nhớ đính kèm ảnh minh chứng." }));
    if (!aiStatus.ready) container.appendChild(h("div", { class: "warn-box", style: "margin-top:10px", text: "AI chưa sẵn sàng — bạn vẫn có thể tự viết nội dung tay bên dưới." }));

    // Thông tin sinh viên (từ hồ sơ đã đồng bộ).
    container.appendChild(h("div", { class: "card", style: "margin-top:12px" }, [
        h("div", { class: "card-head" }, [h("h3", { text: "Người viết đơn" }), (!student.name || !student.mssv) ? h("span", { class: "badge orange", text: "Thiếu hồ sơ" }) : h("span", { class: "badge green", text: "OK" })]),
        h("div", { class: "grid cols-3" }, [
            infoCell("Họ tên", student.name),
            infoCell("MSSV", student.mssv),
            infoCell("Lớp", student.class),
        ]),
        (!student.name || !student.mssv) ? h("div", { class: "muted small", style: "margin-top:6px" }, ["Chưa có tên/MSSV. Vào ", h("a", { href: "#sync" }, "Đồng bộ portal"), " để lấy hồ sơ, hoặc nhập ở ", h("a", { href: "#settings" }, "Cài đặt"), "."]) : "",
    ]));

    const state = { imagePath: "" };

    const courseSel = h("select", {}, [h("option", { value: "" }, "— Chọn môn (tự điền GV) —"), ...courses.map((c) => h("option", { value: c.id }, `${c.name}${c.lecturer ? " - " + c.lecturer : ""}`))]);
    const lecturer = h("input", { placeholder: "Tên giảng viên" });
    const to = h("input", { placeholder: "Email giảng viên (bắt buộc để gửi)" });
    const courseName = h("input", { placeholder: "Tên môn/lớp" });
    const reasonType = h("select", {}, REASON_TYPES.map(([v, label], i) => h("option", { value: v, selected: i === 0 }, label)));
    const date = h("input", { type: "date", value: todayISO() });
    const reason = h("textarea", { placeholder: "Mô tả lý do cụ thể (VD: em bị sốt cao phải nghỉ, có giấy khám kèm theo)" });

    // Chọn môn -> tự điền GV + email (lấy từ sổ email theo tên GV, bền qua các lần đồng bộ).
    courseSel.addEventListener("change", () => {
        const c = courses.find((x) => x.id === courseSel.value);
        if (!c) return;
        lecturer.value = c.lecturer || "";
        courseName.value = c.name || "";
        const saved = emailBook[keyFor(c.lecturer, c.name)];
        to.value = saved || c.lecturerEmail || "";
    });

    const saveEmailBtn = h("button", { class: "btn ghost small", onClick: () => saveLecturerEmail(true) }, "Lưu email GV");

    const imgLabel = h("span", { class: "muted small", text: "Chưa chọn ảnh" });
    const pickBtn = h("button", { class: "btn ghost", onClick: async () => {
        const res = await api.mail.pickImage();
        if (res.canceled) return;
        state.imagePath = res.path;
        imgLabel.textContent = res.path.split(/[\\/]/).pop();
    } }, "Chọn ảnh minh chứng");

    const subject = h("input", { placeholder: "Tiêu đề email" });
    const bodyText = h("textarea", { style: "min-height:240px", placeholder: "Nội dung đơn sẽ hiện ở đây sau khi AI soạn — bạn có thể chỉnh sửa trước khi gửi." });

    const smtpBtn = mailConfigured
        ? h("button", { class: "btn ghost", onClick: (e) => sendSmtp(e.currentTarget) }, "Gửi qua SMTP (Gmail)")
        : "";

    const form = h("div", { class: "grid cols-2", style: "margin-top:14px" }, [
        h("div", { class: "card" }, [
            h("h3", { text: "Thông tin đơn" }),
            h("label", { class: "field" }, [h("span", { text: "Môn học" }), courseSel]),
            h("div", { class: "inline-form" }, [
                h("label", { class: "field" }, [h("span", { text: "Tên môn/lớp" }), courseName]),
                h("label", { class: "field" }, [h("span", { text: "Giảng viên" }), lecturer]),
            ]),
            h("label", { class: "field" }, [h("span", { text: "Email giảng viên" }), h("div", { class: "row", style: "gap:6px" }, [to, saveEmailBtn])]),
            h("div", { class: "inline-form" }, [
                h("label", { class: "field" }, [h("span", { text: "Loại lý do" }), reasonType]),
                h("label", { class: "field" }, [h("span", { text: "Ngày nghỉ" }), date]),
            ]),
            h("label", { class: "field" }, [h("span", { text: "Lý do chi tiết" }), reason]),
            h("div", { class: "row", style: "margin-top:6px" }, [pickBtn, imgLabel]),
        ]),
        h("div", { class: "card" }, [
            h("h3", { text: "Nội dung email" }),
            h("label", { class: "field" }, [h("span", { text: "Tiêu đề" }), subject]),
            h("label", { class: "field" }, [h("span", { text: "Thân email" }), bodyText]),
            h("div", { class: "row wrap" }, [
                h("button", { class: "btn accent", onClick: (e) => draft(e.currentTarget) }, "Soạn nội dung (AI)"),
                h("button", { class: "btn primary", onClick: (e) => sendAuto(e.currentTarget) }, "Gửi tự động qua Outlook"),
                h("button", { class: "btn ghost", onClick: (e) => openCompose(e.currentTarget) }, "Mở Outlook soạn tay"),
                smtpBtn,
            ]),
            h("div", { class: "muted small", style: "margin-top:8px", text: "Gửi tự động: app gửi thẳng bằng email trường (đính kèm ảnh minh chứng) — không cần thao tác gì thêm. Hoặc \"Mở Outlook soạn tay\" nếu muốn tự bấm Gửi." }),
        ]),
    ]);
    container.appendChild(form);

    function saveLecturerEmail(notify) {
        const email = to.value.trim();
        const key = keyFor(lecturer.value, courseName.value);
        if (!email || !key) { if (notify) toast("Cần có tên giảng viên (hoặc môn) và email để lưu", "warn"); return; }
        emailBook[key] = email;
        api.settings.set({ student: { lecturerEmails: { [key]: email } } }).catch(() => {});
        if (notify) toast("Đã lưu email giảng viên cho lần sau", "ok");
    }

    async function draft(btn) {
        if (!reason.value.trim()) { toast("Nhập lý do xin nghỉ", "warn"); return; }
        await withButtonLoading(btn, async () => {
            const res = await api.mail.draftLeave({
                course: courseName.value.trim(),
                lecturer: lecturer.value.trim(),
                reasonType: reasonType.value,
                date: date.value,
                reason: reason.value.trim(),
                hasImage: !!state.imagePath,
            });
            subject.value = res.subject || "";
            bodyText.value = res.body || "";
            toast("AI đã soạn xong theo form đơn, kiểm tra rồi gửi nhé", "ok");
        });
    }

    // Gửi HOÀN TOÀN tự động qua Outlook REST (đính kèm ảnh minh chứng, không cần thao tác thêm).
    async function sendAuto(btn) {
        if (!to.value.trim()) { toast("Nhập email giảng viên", "warn"); return; }
        if (!subject.value.trim() || !bodyText.value.trim()) { toast("Chưa có nội dung (bấm Soạn nội dung hoặc tự viết)", "warn"); return; }
        if (!state.imagePath && !(await confirmModal("Chưa đính kèm ảnh minh chứng. Vẫn gửi?", "Thiếu minh chứng"))) return;
        const ok = await confirmModal(`Gửi đơn xin nghỉ tới ${to.value.trim()} bằng email trường của bạn?`, "Xác nhận gửi");
        if (!ok) return;
        saveLecturerEmail(false);
        await withButtonLoading(btn, async () => {
            await api.mail.sendOutlook({ to: to.value.trim(), subject: subject.value.trim(), body: bodyText.value, imagePath: state.imagePath || "" });
            toast("Đã gửi đơn xin nghỉ tới " + to.value.trim() + " (kèm minh chứng).", "ok", "Gửi thành công");
        });
    }

    // Phương án phụ: mở Outlook Web soạn sẵn để tự bấm Gửi.
    async function openCompose(btn) {
        if (!to.value.trim()) { toast("Nhập email giảng viên", "warn"); return; }
        if (!subject.value.trim() || !bodyText.value.trim()) { toast("Chưa có nội dung (bấm Soạn nội dung hoặc tự viết)", "warn"); return; }
        saveLecturerEmail(false);
        await withButtonLoading(btn, async () => {
            await api.mail.outlookCompose({ to: to.value.trim(), subject: subject.value.trim(), body: bodyText.value });
            const imgNote = state.imagePath ? `Đừng quên đính kèm ảnh: ${state.imagePath.split(/[\\/]/).pop()}` : "";
            toast("Đã mở Outlook với nội dung điền sẵn. " + imgNote, "ok", "Soạn trên Outlook");
        });
    }

    async function sendSmtp(btn) {
        if (!to.value.trim()) { toast("Nhập email giảng viên", "warn"); return; }
        if (!state.imagePath) { toast("Cần đính kèm ảnh minh chứng", "warn"); return; }
        if (!subject.value.trim() || !bodyText.value.trim()) { toast("Chưa có nội dung email", "warn"); return; }
        const ok = await confirmModal(`Gửi email xin nghỉ tới ${to.value.trim()} qua SMTP?`, "Xác nhận gửi");
        if (!ok) return;
        saveLecturerEmail(false);
        await withButtonLoading(btn, async () => {
            const res = await api.mail.send({ to: to.value.trim(), subject: subject.value.trim(), body: bodyText.value, imagePath: state.imagePath });
            toast("Đã gửi tới " + (res.accepted || []).join(", "), "ok", "Gửi thành công");
        });
    }
}

function infoCell(label, val) {
    return h("div", { style: "margin-bottom:6px" }, [h("div", { class: "muted small", text: label }), h("div", { text: val || "—" })]);
}
