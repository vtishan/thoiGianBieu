import * as api from "../api.js";
import { h, clear, toast, confirmModal, fmtDateTime, withButtonLoading } from "../ui.js";

// Quyển vở viết: mỗi TỜ là lưới 36 dòng cố định (mỗi dòng = 1 ô, KHÔNG tự bọc dòng).
//  - Bấm vào dòng nào cũng viết được (kể cả dòng 36 khi mới có dòng 2) -> tự chèn dòng trống tới đó.
//  - Viết quá 36 dòng -> tự tràn sang tờ sau. Tờ trống ở giữa vẫn giữ, điều hướng & viết bổ sung được.
//  - cur.pages = string[]  (mảng 2 chiều: chiều 1 = các tờ; chiều 2 = các dòng ngăn bởi "\n").
const LINE = 34;      // chiều cao mỗi dòng kẻ (px) — khớp line-height trong CSS
const MAX_ROWS = 36;  // 1 tờ đúng 36 dòng
const SPINES = ["blue", "green", "orange", "red", "violet", "teal"];

export async function render(container, ctx) {
    await drawShelf(container, ctx);
}

function splitIntoPages(content) {
    const lines = String(content || "").split(/\r?\n/);
    if (lines.length <= MAX_ROWS) return [content || ""];
    const pages = [];
    for (let i = 0; i < lines.length; i += MAX_ROWS) pages.push(lines.slice(i, i + MAX_ROWS).join("\n"));
    return pages.length ? pages : [""];
}
function pageCountOf(note) {
    if (Array.isArray(note.pages) && note.pages.length) return note.pages.length;
    return splitIntoPages(note.content).length;
}

// ===== Kệ vở (danh sách) =====
async function drawShelf(container, ctx) {
    ctx.setTitle("Textbook");
    ctx.setActions([
        h("button", { class: "btn ghost", onClick: (e) => exportAll(e.currentTarget) }, "Xuất tất cả DOCX"),
        h("button", { class: "btn primary", onClick: () => openNotebook(container, ctx, null) }, "+ Vở mới"),
    ]);
    clear(container);

    const notes = (await api.store.all("textbook")).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    container.appendChild(h("div", { class: "note-box", text: "Vở viết của bạn — giấy kẻ 36 dòng, bấm vào dòng nào cũng viết được, hết tờ tự sang tờ mới. Vừa để ôn tập vừa là bộ nhớ cho AI. Xuất được ra Word (.docx)." }));

    if (!notes.length) {
        container.appendChild(h("div", { class: "empty", style: "margin-top:14px" }, [
            "Chưa có quyển vở nào. Bấm ", h("strong", { text: "\"+ Vở mới\"" }), " để mở trang giấy và bắt đầu viết.",
        ]));
        return;
    }

    const grid = h("div", { class: "grid cols-3 nb-shelf", style: "margin-top:14px" });
    notes.forEach((n, i) => {
        const preview = (n.content || "").replace(/^#{1,3}\s+/gm, "").trim().split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
        grid.appendChild(h("div", { class: "card nb-cover spine-" + SPINES[i % SPINES.length], onClick: () => openNotebook(container, ctx, n) }, [
            h("div", { class: "nb-cover-title", text: n.title || "(không tiêu đề)" }),
            h("div", { class: "nb-cover-lines" }, preview.length
                ? preview.map((l) => h("div", { class: "nb-cover-line", text: l }))
                : [h("div", { class: "muted small", text: "(trang trống)" })]),
            h("div", { class: "nb-cover-foot" }, [
                h("span", { class: "muted small", text: fmtDateTime(n.updatedAt) }),
                h("span", { class: "badge gray", text: pageCountOf(n) + " tờ" }),
            ]),
            h("div", { class: "nb-cover-actions", onClick: (e) => e.stopPropagation() }, [
                h("button", { class: "btn small ghost", onClick: (e) => exportOne(n, e.currentTarget) }, "Xuất DOCX"),
                h("button", {
                    class: "btn small danger", onClick: async () => {
                        if (await confirmModal(`Xoá quyển vở "${n.title || "(không tiêu đề)"}"?`)) {
                            await api.store.remove("textbook", n.id);
                            toast("Đã xoá", "ok");
                            drawShelf(container, ctx);
                        }
                    },
                }, "Xoá"),
            ]),
        ]));
    });
    container.appendChild(grid);
}

// ===== Trình soạn thảo quyển vở =====
function openNotebook(container, ctx, note) {
    const cur = note
        ? {
            id: note.id, title: note.title || "", tags: note.tags || [], font: note.font || "clean",
            pages: (Array.isArray(note.pages) && note.pages.length) ? note.pages.slice() : [String(note.content || "")],
        }
        : { id: null, title: "", tags: [], font: "clean", pages: [""] };
    cur.idx = 0;

    const FIXED = MAX_ROWS * LINE;
    let dirty = false;
    let saveTimer = null;
    let closed = false;
    let composing = false;

    ctx.setTitle(cur.title ? "Vở: " + cur.title : "Vở mới");
    ctx.setActions([]);

    // --- Điều khiển ---
    const status = h("span", { class: "nb-status" + (cur.id ? " saved" : ""), text: cur.id ? "Đã lưu" : "Mới" });
    const count = h("span", { class: "nb-count muted small" });
    const titleInput = h("input", { class: "nb-title", value: cur.title, placeholder: "Tên quyển vở…" });
    const tagsInput = h("input", { class: "nb-tags", value: (cur.tags || []).join(", "), placeholder: "# thẻ…" });
    const fontBtn = h("button", { class: "btn small ghost nb-chip", title: "Đổi kiểu chữ: thường / viết tay", onClick: () => { setFont(cur.font === "hand" ? "clean" : "hand"); markDirty(); } });

    const pageInd = h("span", { class: "nb-pageind" });
    const prevBtn = h("button", { class: "btn small ghost nb-nav", title: "Tờ trước", onClick: () => goPage(cur.idx - 1) }, "‹");
    const nextBtn = h("button", { class: "btn small ghost nb-nav", title: "Tờ sau (tạo mới nếu hết)", onClick: () => goPage(cur.idx + 1) }, "›");
    const addBtn = h("button", { class: "btn small ghost nb-nav", title: "Chèn tờ mới sau tờ này", onClick: () => addPage() }, "＋");
    const delBtn = h("button", { class: "btn small ghost nb-nav", title: "Xoá tờ này", onClick: () => delPage() }, "🗑");

    // --- Trang giấy ---
    const gutter = h("div", { class: "nb-gutter" });
    { let s = ""; for (let i = 1; i <= MAX_ROWS; i++) s += i + "\n"; gutter.textContent = s; } // số dòng tĩnh 1..36
    const ta = h("textarea", { class: "nb-ink", spellcheck: "false", placeholder: "Bấm vào dòng bất kỳ để viết…", wrap: "off" });
    const pageNo = h("div", { class: "nb-pageno" });
    const page = h("div", { class: "nb-page" }, [gutter, ta, pageNo]);

    const bar = h("div", { class: "nb-bar" }, [
        h("button", { class: "btn small ghost", title: "Về kệ vở", onClick: () => back() }, "← Kệ vở"),
        titleInput,
        tagsInput,
        fontBtn,
        h("span", { class: "nb-pager" }, [prevBtn, pageInd, nextBtn, h("span", { class: "nb-pager-sep" }), addBtn, delBtn]),
        h("span", { class: "spacer" }),
        count,
        status,
        h("button", { class: "btn small primary nb-chip", onClick: (e) => exportCurrent(e.currentTarget) }, "⭳ DOCX"),
    ]);

    clear(container);
    container.appendChild(bar);
    container.appendChild(page);

    ta.value = cur.pages[cur.idx] || "";
    ta.style.height = FIXED + "px";

    // ÉP nền giấy SÁNG bằng inline style (thắng mọi quy tắc chung của app -> không thể bị tối/xám).
    page.style.setProperty("background", "#ffffff", "important");
    ta.style.setProperty("background", "transparent", "important");
    ta.style.setProperty("color", "#1f2733", "important");
    gutter.style.setProperty("background", "transparent", "important");

    function setFont(f) {
        cur.font = f;
        ta.className = "nb-ink font-" + f;
        fontBtn.textContent = f === "hand" ? "✍ Viết tay" : "A Chữ thường";
    }
    setFont(cur.font);

    // Cào tràn về phía TRƯỚC: tờ nào > 36 dòng thì đẩy phần dư sang tờ sau (thuần chuỗi, giữ nguyên join).
    function reflowFrom(p) {
        for (let i = Math.max(0, p); i < cur.pages.length; i++) {
            const lines = cur.pages[i].split("\n");
            if (lines.length > MAX_ROWS) {
                const overflow = lines.slice(MAX_ROWS).join("\n");
                cur.pages[i] = lines.slice(0, MAX_ROWS).join("\n");
                if (i + 1 >= cur.pages.length) cur.pages.push("");
                cur.pages[i + 1] = overflow + (cur.pages[i + 1] ? "\n" + cur.pages[i + 1] : "");
            }
        }
    }

    // Con trỏ theo vị trí tuyệt đối trong cur.pages.join("\n") -> ổn định qua reflow.
    function caretAbs() {
        let abs = 0;
        for (let i = 0; i < cur.idx; i++) abs += cur.pages[i].length + 1;
        return abs + ta.selectionStart;
    }
    function restoreCaret(abs) {
        let i = 0;
        while (i < cur.pages.length && abs > cur.pages[i].length) { abs -= cur.pages[i].length + 1; i++; }
        if (i >= cur.pages.length) { i = cur.pages.length - 1; abs = cur.pages[i].length; }
        if (abs < 0) abs = 0;
        if (i !== cur.idx) { cur.idx = i; loadPage(); }
        else if (ta.value !== cur.pages[cur.idx]) ta.value = cur.pages[cur.idx];
        try { ta.setSelectionRange(abs, abs); ta.focus(); } catch { /* ignore */ }
        updateLine();
    }

    // Dòng hiện tại của con trỏ.
    function updateLine() {
        const line = Math.min(MAX_ROWS, ta.value.slice(0, ta.selectionStart).split("\n").length);
        const words = (ta.value.trim().match(/\S+/g) || []).length;
        count.textContent = `Dòng ${line}/${MAX_ROWS} · ${words} từ`;
    }
    function updatePager() {
        pageInd.textContent = `Tờ ${cur.idx + 1}/${cur.pages.length}`;
        pageNo.textContent = `— ${cur.idx + 1} —`;
        prevBtn.disabled = cur.idx <= 0;
        delBtn.disabled = cur.pages.length <= 1;
    }
    function loadPage() {
        ta.value = cur.pages[cur.idx] || "";
        ta.style.height = FIXED + "px";
        updateLine();
        updatePager();
        const view = document.getElementById("view");
        if (view) view.scrollTop = 0;
    }

    function handleInput() {
        const abs = caretAbs();
        cur.pages[cur.idx] = ta.value;
        reflowFrom(cur.idx);
        restoreCaret(abs);
        updatePager();
        markDirty();
    }

    // Bấm vào một dòng TRỐNG bên dưới nội dung -> chèn các dòng trống tới đó rồi đặt con trỏ.
    ta.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || composing) return;
        const targetRow = Math.min(MAX_ROWS - 1, Math.floor((e.offsetY || 0) / LINE));
        const lineCount = ta.value.split("\n").length; // số dòng hiện có
        if (targetRow >= lineCount) {
            e.preventDefault();
            ta.value = ta.value + "\n".repeat(targetRow - (lineCount - 1));
            const pos = ta.value.length;
            ta.setSelectionRange(pos, pos);
            ta.focus();
            handleInput();
        }
    });

    ta.addEventListener("compositionstart", () => { composing = true; });
    ta.addEventListener("compositionend", () => { composing = false; handleInput(); });
    ta.addEventListener("input", (e) => {
        if (composing || (e && e.isComposing)) { cur.pages[cur.idx] = ta.value; markDirty(); return; }
        handleInput();
    });
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !composing) {
            // Đang ở dòng cuối (36) -> sang tờ sau thay vì chèn dòng.
            const line = ta.value.slice(0, ta.selectionStart).split("\n").length;
            if (line >= MAX_ROWS) { e.preventDefault(); goPage(cur.idx + 1); return; }
        }
        if (e.key === "Tab") {
            e.preventDefault();
            const s = ta.selectionStart, en = ta.selectionEnd;
            ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(en);
            ta.selectionStart = ta.selectionEnd = s + 4;
            handleInput();
        }
    });
    ta.addEventListener("keyup", updateLine);
    ta.addEventListener("click", updateLine);
    titleInput.addEventListener("input", () => { cur.title = titleInput.value; ctx.setTitle(cur.title ? "Vở: " + cur.title : "Vở mới"); markDirty(); });
    tagsInput.addEventListener("input", () => markDirty());
    page.addEventListener("mousedown", (e) => { if (e.target === page || e.target === gutter || e.target === pageNo) { e.preventDefault(); ta.focus(); } });

    // --- Lật / thêm / xoá tờ ---
    function goPage(idx) {
        cur.pages[cur.idx] = ta.value;
        if (idx < 0) return;
        if (idx >= cur.pages.length) { cur.pages.push(""); markDirty(); } // luôn next được: tạo tờ mới
        cur.idx = idx;
        loadPage();
        ta.focus();
    }
    function addPage() {
        cur.pages[cur.idx] = ta.value;
        cur.pages.splice(cur.idx + 1, 0, "");
        cur.idx += 1;
        markDirty();
        loadPage();
        ta.focus();
    }
    async function delPage() {
        if (cur.pages.length <= 1) return;
        if (!(await confirmModal(`Xoá tờ ${cur.idx + 1}? Nội dung tờ này sẽ mất.`))) return;
        cur.pages.splice(cur.idx, 1);
        if (cur.idx >= cur.pages.length) cur.idx = cur.pages.length - 1;
        markDirty();
        loadPage();
        ta.focus();
    }

    // --- Lưu (debounce) ---
    function markDirty() {
        dirty = true;
        status.className = "nb-status saving";
        status.textContent = "Đang lưu…";
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { save(); }, 900);
    }
    async function save() {
        if (!dirty) return;
        cur.pages[cur.idx] = ta.value;
        const payload = {
            title: titleInput.value.trim() || "(không tiêu đề)",
            tags: tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean),
            pages: cur.pages,
            content: cur.pages.join("\n"),
            font: cur.font,
        };
        try {
            if (cur.id) await api.store.update("textbook", cur.id, payload);
            else { const rec = await api.store.add("textbook", payload); cur.id = rec.id; }
            dirty = false;
            status.className = "nb-status saved";
            status.textContent = "Đã lưu";
        } catch (err) {
            status.className = "nb-status err";
            status.textContent = "Lỗi lưu";
            toast(err.message || String(err), "error", "Lưu vở");
        }
    }

    async function back() {
        if (closed) return;
        closed = true;
        if (saveTimer) clearTimeout(saveTimer);
        await save();
        await drawShelf(container, ctx);
    }

    async function exportCurrent(btn) {
        await withButtonLoading(btn, async () => {
            cur.pages[cur.idx] = ta.value;
            if (!cur.pages.join("").trim() && !titleInput.value.trim()) { toast("Vở đang trống, chưa có gì để xuất.", "warn"); return; }
            dirty = true;
            await save();
            if (!cur.id) return;
            const res = await api.docx.exportTextbook(cur.id);
            if (res.canceled) return;
            toast("Đã xuất: " + res.filePath, "ok", "Xuất DOCX");
        });
    }

    // Khởi tạo: cắt nội dung cũ thành các tờ 36 dòng rồi hiển thị.
    requestAnimationFrame(() => {
        reflowFrom(0);
        cur.idx = 0;
        loadPage();
        ta.focus();
    });
}

async function exportOne(note, btn) {
    await withButtonLoading(btn, async () => {
        const res = await api.docx.exportTextbook(note.id);
        if (res.canceled) return;
        toast("Đã xuất: " + res.filePath, "ok", "Xuất DOCX");
    });
}

async function exportAll(btn) {
    await withButtonLoading(btn, async () => {
        const res = await api.docx.exportAll();
        if (res.canceled) return;
        toast("Đã xuất: " + res.filePath, "ok", "Xuất DOCX");
    });
}
