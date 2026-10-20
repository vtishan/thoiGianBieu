import * as api from "../api.js";
import { h, clear, toast, todayISO, fmtDate, withButtonLoading, confirmModal } from "../ui.js";

const TYPE_LABEL = { study: "Học", review: "Ôn tập", assignment: "Làm bài tập", rest: "Nghỉ", custom: "Cá nhân" };

export async function render(container, ctx) {
    ctx.setActions([]);
    clear(container);

    const status = await api.ai.status();
    if (!status.ready) {
        container.appendChild(h("div", { class: "warn-box" }, [
            "Trợ lý AI chưa sẵn sàng. Hãy kiểm tra lại tại ", h("a", { href: "#settings" }, "Cài đặt"), " trước khi dùng tính năng này.",
        ]));
    }

    const cols = h("div", { class: "grid cols-2" });

    // ===== 1. AI tu lap lich hoc =====
    const planCard = h("div", { class: "card" }, [h("h3", { text: "AI lập kế hoạch học" })]);
    planCard.appendChild(h("p", { class: "muted small", text: "Mô tả thời gian rảnh, AI sẽ sắp lịch học/ôn dựa trên bài tập chưa xong và lịch thi của bạn." }));
    const dateInput = h("input", { type: "date", value: todayISO() });
    const freeText = h("textarea", { placeholder: "VD: Ngày mai học 7h tới 12h30, buổi chiều và tối rảnh." });
    planCard.appendChild(h("label", { class: "field" }, [h("span", { text: "Ngày cần lập kế hoạch" }), dateInput]));
    planCard.appendChild(h("label", { class: "field" }, [h("span", { text: "Mô tả thời gian rảnh" }), freeText]));
    const planResult = h("div", { style: "margin-top:12px" });
    const planBtn = h("button", { class: "btn primary", onClick: (e) => runPlan(e.currentTarget) }, "Lập kế hoạch");
    planCard.appendChild(planBtn);
    planCard.appendChild(planResult);
    cols.appendChild(planCard);

    async function runPlan(btn) {
        if (!freeText.value.trim()) { toast("Nhập mô tả thời gian rảnh", "warn"); return; }
        await withButtonLoading(btn, async () => {
            const res = await api.ai.planSchedule({ text: freeText.value.trim(), date: dateInput.value || todayISO() });
            renderBlocks(planResult, res.blocks, res.summary, ctx);
        });
    }

    // ===== 2. Them nhanh bang cau tu nhien =====
    const nlCard = h("div", { class: "card" }, [h("h3", { text: "Thêm lịch bằng câu tự nhiên" })]);
    nlCard.appendChild(h("p", { class: "muted small", text: 'Gõ như nói chuyện, AI tự hiểu và thêm vào lịch. VD: "2h chiều mai tôi có lịch đi học thêm".' }));
    const nlText = h("textarea", { placeholder: "VD: Tối nay 8h học Toán 90 phút; sáng chủ nhật đi làm thêm 8h-11h." });
    nlCard.appendChild(h("label", { class: "field" }, [h("span", { text: "Nội dung" }), nlText]));
    const nlResult = h("div", { style: "margin-top:12px" });
    const nlBtn = h("button", { class: "btn accent", onClick: (e) => runNL(e.currentTarget) }, "Phân tích & thêm");
    nlCard.appendChild(nlBtn);
    nlCard.appendChild(nlResult);
    cols.appendChild(nlCard);

    async function runNL(btn) {
        if (!nlText.value.trim()) { toast("Nhập nội dung", "warn"); return; }
        await withButtonLoading(btn, async () => {
            const events = await api.ai.parseNaturalSchedule(nlText.value.trim());
            renderBlocks(nlResult, events, "AI đã hiểu và tạo các sự kiện sau:", ctx, true);
        });
    }

    container.appendChild(cols);

    // ===== Cac su kien da luu =====
    await drawSaved(container, ctx);
}

function nextDayISO(iso) {
    const d = new Date((iso || todayISO()) + "T00:00:00");
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Block đã trôi qua so với hiện tại chưa (giờ địa phương).
function isPastBlock(b) {
    if (!b || !b.date || !b.start) return false;
    const t = new Date(`${b.date}T${b.start}:00`);
    return !isNaN(t.getTime()) && t.getTime() < Date.now();
}

function renderBlocks(host, blocks, summary, ctx, isNL) {
    if (!blocks || !blocks.length) {
        clear(host);
        host.appendChild(h("div", { class: "muted small", text: "AI không tạo được mục nào. Thử mô tả rõ hơn." }));
        return;
    }

    // Vẽ (lại) danh sách + nút lưu; tách hàm để nút "Dời sang ngày mai" có thể vẽ lại tức thì.
    function paint() {
        clear(host);
        if (summary) host.appendChild(h("div", { class: "note-box", style: "margin-bottom:10px", text: summary }));

        const anyPast = blocks.some(isPastBlock);
        if (anyPast) {
            host.appendChild(h("div", { class: "warn-box", style: "margin-bottom:10px" }, [
                "Có mục rơi vào thời gian ĐÃ QUA. Bạn có thể bấm “Dời sang ngày mai” ở mục đó, hoặc lưu như hiện tại nếu muốn ghi lại.",
            ]));
        }

        blocks.forEach((b) => {
            const past = isPastBlock(b);
            const actions = past
                ? h("div", { class: "row wrap", style: "gap:8px; margin-top:6px; align-items:center" }, [
                    h("span", { class: "badge orange", text: "Giờ đã qua" }),
                    h("button", { class: "btn small ghost", onClick: () => { b.date = nextDayISO(b.date); b.adjusted = true; paint(); } }, "Dời sang ngày mai"),
                ])
                : null;
            host.appendChild(h("div", { class: "slot " + (b.type === "rest" ? "rest" : (past ? "" : "study")) }, [
                h("div", { class: "slot-time", text: `${b.start || "?"}–${b.end || "?"}` }),
                h("div", {}, [
                    h("div", { text: `${b.title || "(học)"} ${b.date ? "• " + fmtDate(b.date) : ""}` }),
                    h("div", { class: "muted small", text: `${TYPE_LABEL[b.type] || b.type || ""}${b.note ? " • " + b.note : ""}` }),
                    actions,
                ]),
            ]));
        });

        host.appendChild(h("button", { class: "btn primary", style: "margin-top:10px", onClick: async (e) => {
            await withButtonLoading(e.currentTarget, async () => {
                for (const b of blocks) {
                    await api.store.add("events", {
                        title: b.title || "Học", date: b.date || todayISO(), start: b.start || "", end: b.end || "",
                        type: b.type || (isNL ? "custom" : "study"), note: b.note || "", source: "ai",
                    });
                }
                toast(`Đã lưu ${blocks.length} mục vào lịch`, "ok");
                clear(host);
                await drawSaved(document.getElementById("view"), ctx, true);
            });
        } }, `Lưu ${blocks.length} mục vào lịch`));
    }

    paint();
}

async function drawSaved(container, ctx, rerenderOnly) {
    // Xoa phan cu neu co
    const old = container.querySelector("#saved-events");
    if (old) old.remove();

    const events = (await api.store.all("events")).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const wrap = h("div", { id: "saved-events", style: "margin-top:18px" }, [
        h("div", { class: "card-head" }, [h("h3", { text: "Lịch đã lưu" }), events.length ? h("button", { class: "btn small ghost", onClick: () => ctx.navigate("timemap") }, "Xem bản đồ thời gian") : null]),
    ]);
    if (!events.length) {
        wrap.appendChild(h("div", { class: "empty", text: "Chưa có sự kiện tự thêm nào." }));
    } else {
        events.forEach((ev) => wrap.appendChild(h("div", { class: "item" }, [
            h("div", { class: "item-main" }, [
                h("div", { class: "item-title", text: ev.title }),
                h("div", { class: "item-sub", text: `${fmtDate(ev.date)} • ${ev.start || "?"}–${ev.end || "?"} • ${TYPE_LABEL[ev.type] || ev.type || ""}${ev.source === "ai" ? " • AI" : ""}` }),
            ]),
            h("button", { class: "btn small danger", onClick: async () => {
                await api.store.remove("events", ev.id); toast("Đã xoá", "ok"); drawSaved(container, ctx);
            } }, "Xoá"),
        ])));
    }
    container.appendChild(wrap);
}
