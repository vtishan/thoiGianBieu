"use strict";

/**
 * Bộ điều phối AI. Chọn provider theo cấu hình (API key hoặc cookie),
 * và cung cấp các hàm cấp cao cho toàn app:
 *   - ask: hỏi đáp chung
 *   - checkKnowledge: kiểm chứng một nhận định
 *   - explain: giải thích kiến thức (có dùng tài liệu + textbook làm ngữ cảnh)
 *   - planSchedule: lập kế hoạch học từ thời gian rảnh + bài tập + lịch thi
 *   - parseNaturalSchedule: hiểu câu tự nhiên -> sự kiện lịch
 *   - examPlan: lộ trình ôn thi
 *   - summarizeDocument: tóm tắt tài liệu + trích keyword + gợi ý học
 *   - draftLeaveEmail: soạn email xin nghỉ đúng form
 */

const store = require("../store");
const geminiApi = require("./geminiApi");
const geminiCookie = require("./geminiCookie");

const DAY_VI = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
const AI_IDENTITY =
    "Bạn là Trợ lý AI của ứng dụng học tập CMC. Không tự giới thiệu hoặc nhắc tên nhà cung cấp, nền tảng hay tên mô hình AI đang vận hành.";

function setDataDir(dir) {
    geminiCookie.setDataDir(dir);
}

function provider() {
    const s = store.getSettings();
    return (s.ai && s.ai.provider) || "api";
}

function status() {
    const s = store.getSettings();
    const p = (s.ai && s.ai.provider) || "cookie";
    if (p === "api" && s.ai && s.ai.apiKey) {
        return { provider: "api", ready: true, model: "AI tiêu chuẩn" };
    }
    // Mặc định: Gemini web chế độ khách -> luôn sẵn sàng, không cần đăng nhập.
    const authed = geminiCookie.isAuthenticated();
    return { provider: "cookie", ready: true, guest: !authed, model: "Trợ lý AI" };
}

async function ask(prompt, opts = {}) {
    const s = store.getSettings();
    const p = (s.ai && s.ai.provider) || "api";
    const requestOpts = {
        ...opts,
        system: opts.system ? `${AI_IDENTITY}\n${opts.system}` : AI_IDENTITY,
    };
    if (p === "cookie") {
        return geminiCookie.ask(null, prompt, requestOpts);
    }
    return geminiApi.ask(s.ai || {}, prompt, requestOpts);
}

// ===== Tiện ích =====

function pad2(n) {
    return String(n).padStart(2, "0");
}
// Ngày theo GIỜ ĐỊA PHƯƠNG (KHÔNG dùng toISOString vì sẽ lệch ngày ở múi giờ VN).
function localISODate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nowContext() {
    const d = new Date();
    return `Bây giờ là ${DAY_VI[d.getDay()]}, ngày ${localISODate(d)}, lúc ${pad2(d.getHours())}:${pad2(d.getMinutes())} (giờ địa phương).`;
}

function addDaysISO(baseISODate, days) {
    const d = new Date(baseISODate + "T00:00:00");
    d.setDate(d.getDate() + days);
    return localISODate(d);
}

// Sự kiện đã trôi qua so với hiện tại chưa (so sánh theo giờ địa phương).
function isPastEvent(ev, now) {
    if (!ev || !ev.date || !ev.start) return false;
    const t = new Date(`${ev.date}T${ev.start}:00`);
    if (isNaN(t.getTime())) return false;
    return t.getTime() < now.getTime();
}

// Trích JSON từ văn bản (provider cookie không có chế độ JSON thuần).
function extractJson(text) {
    if (text == null) return null;
    const raw = String(text).trim();
    try {
        return JSON.parse(raw);
    } catch {
        /* thử bóc khối JSON */
    }
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {
            /* ignore */
        }
    }
    const start = raw.search(/[[{]/);
    if (start !== -1) {
        const open = raw[start];
        const close = open === "{" ? "}" : "]";
        const end = raw.lastIndexOf(close);
        if (end > start) {
            try {
                return JSON.parse(raw.slice(start, end + 1));
            } catch {
                /* ignore */
            }
        }
    }
    return null;
}

async function askJson(prompt, opts = {}) {
    const text = await ask(prompt, { ...opts, json: true });
    const parsed = extractJson(text);
    if (parsed == null) {
        const e = new Error("AI không trả về JSON hợp lệ.");
        e.code = "AI_JSON";
        e.raw = text;
        throw e;
    }
    return parsed;
}

// ===== Ngữ cảnh học tập =====

function pendingAssignments(limit = 30) {
    const now = Date.now();
    return store
        .all("assignments")
        .filter((a) => !a.done)
        .sort((a, b) => (new Date(a.deadline || 0) - new Date(b.deadline || 0)))
        .slice(0, limit)
        .map((a) => ({
            title: a.title,
            course: a.course || "",
            source: a.source || "",
            deadline: a.deadline || "",
            overdue: a.deadline ? new Date(a.deadline).getTime() < now : false,
        }));
}

function upcomingExams(limit = 20) {
    const today = new Date().toISOString().slice(0, 10);
    return store
        .all("exams")
        .filter((e) => (e.date || "") >= today)
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
        .slice(0, limit);
}

function coursesSummary() {
    return store.all("courses").map((c) => ({
        name: c.name,
        code: c.code || "",
        day: DAY_VI[Number(c.day)] || c.day,
        start: c.start,
        end: c.end,
        mode: c.mode || "offline",
        room: c.room || "",
    }));
}

function studyMemory() {
    const notes = store.all("textbook").map((t) => `- ${t.title}: ${String(t.content || "").slice(0, 200)}`);
    const docs = store.all("documents").map((d) => `- ${d.name}: ${String(d.summary || "").slice(0, 200)}`);
    return { notes, docs };
}

// ===== Các hàm cấp cao =====

// Chuẩn hoá lịch sử hội thoại từ renderer -> [{role:'user'|'model', text}] để AI có ngữ cảnh.
function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((m) => m && typeof m.text === "string" && m.text.trim())
        .slice(-10) // giữ tối đa 10 lượt gần nhất, tránh prompt quá dài
        .map((m) => ({ role: m.role === "model" || m.role === "ai" ? "model" : "user", text: String(m.text).slice(0, 2000) }));
}

async function checkKnowledge(statement) {
    // Kiểm chứng từng nhận định là ĐỘC LẬP -> hỏi one-shot (không nối vào cuộc trò chuyện chính).
    const system =
        "Bạn là trợ giảng đại học nghiêm túc và chính xác. Nhiệm vụ: kiểm chứng nhận định của sinh viên. " +
        "Trả lời NGẮN GỌN bằng tiếng Việt gồm: 1) Kết luận (Đúng / Chưa chính xác / Đúng một phần), " +
        "2) Giải thích ngắn, 3) Nếu sai thì nêu thông tin đúng. Không bịa.";
    return ask(`Nhận định cần kiểm chứng:\n"${statement}"`, { system, temperature: 0.2 });
}

async function explain(topic, history) {
    const mem = studyMemory();
    const memText =
        mem.notes.length || mem.docs.length
            ? `\n\n(Tư liệu của sinh viên — chỉ dùng nếu liên quan, đừng nhắc tới nếu không cần):\nGhi chú:\n${mem.notes.join("\n") || "(trống)"}\nTài liệu:\n${mem.docs.join("\n") || "(trống)"}`
            : "";
    // memText đưa vào system để chỉ gửi ở LƯỢT ĐẦU của cuộc trò chuyện (chế độ cookie) -> đỡ tốn token.
    const system =
        "Bạn là trợ lý học tập thân thiện cho sinh viên, trả lời bằng tiếng Việt tự nhiên. " +
        "Đây là MỘT cuộc trò chuyện liên tục: hãy nhớ và bám theo các câu đã trao đổi trước đó, đừng coi mỗi câu là một hội thoại mới. " +
        "Trả lời NGẮN GỌN, đi thẳng vào trọng tâm; độ dài tương xứng với câu hỏi. " +
        "Nếu người dùng chỉ chào hỏi hay nói chuyện phiếm, hãy đáp lại ngắn gọn 1-2 câu và hỏi họ cần giúp gì — TUYỆT ĐỐI không giảng giải, không phân tích học thuật. " +
        "Chỉ khi được hỏi một kiến thức/khái niệm cụ thể mới giải thích, kèm ví dụ khi thật sự cần, và vẫn ngắn gọn. " +
        "Không tự thêm tiêu đề, dàn bài, bảng biểu dài dòng khi không cần. Chính xác, không bịa." + memText;
    // conversationId "assistant": giữ nguyên 1 cuộc trò chuyện Gemini (đỡ token). history chỉ dùng cho chế độ API key.
    return ask(topic, { system, temperature: 0.4, history: normalizeHistory(history), conversationId: "assistant" });
}

async function planSchedule(input) {
    const text = typeof input === "string" ? input : (input && input.text) || "";
    const baseDate = (input && input.date) || new Date().toISOString().slice(0, 10);

    const ctx = {
        homNay: nowContext(),
        ngayLapKeHoach: baseDate,
        thoiKhoaBieu: coursesSummary(),
        baiTapChuaXong: pendingAssignments(),
        lichThi: upcomingExams(),
    };

    const system =
        "Bạn là trợ lý lập kế hoạch học tập cho sinh viên. Dựa vào thời khóa biểu, bài tập chưa xong và lịch thi, " +
        "hãy sắp xếp các block học/ôn/nghỉ hợp lý vào các khoảng thời gian RẢNH mà sinh viên mô tả. " +
        "Ưu tiên bài tập gần deadline và môn sắp thi. Xen kẽ nghỉ ngơi. " +
        "CHỈ trả về JSON đúng schema:\n" +
        '{ "summary": string, "blocks": [ { "date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM", "title": string, "type": "study|review|assignment|rest", "note": string } ] }';

    const prompt =
        `${ctx.homNay}\nNgày cần lập kế hoạch: ${baseDate}.\n` +
        `Mô tả thời gian rảnh của sinh viên: "${text}"\n\n` +
        `DỮ LIỆU:\n${JSON.stringify(ctx, null, 2)}\n\n` +
        "Hãy tạo kế hoạch. Chỉ trả JSON.";

    const data = await askJson(prompt, { system, temperature: 0.4 });
    const blocks = Array.isArray(data.blocks) ? data.blocks : [];
    return { summary: data.summary || "", blocks };
}

async function parseNaturalSchedule(text) {
    const now = new Date();
    const today = localISODate(now);
    const tmr = new Date(now);
    tmr.setDate(tmr.getDate() + 1);
    const tomorrow = localISODate(tmr);
    const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

    const system =
        "Bạn chuyển câu tiếng Việt tự nhiên của sinh viên thành sự kiện lịch. " +
        "Suy luận ngày/giờ dựa trên mốc HIỆN TẠI (hôm nay, ngày mai, chiều, tối...). " +
        "QUY TẮC GIỜ ĐÃ QUA: nếu người dùng chỉ nói giờ mà KHÔNG nói rõ ngày, và giờ đó ĐÃ TRÔI QUA so với thời điểm hiện tại trong hôm nay, " +
        "thì xếp sự kiện vào NGÀY MAI (lần gần nhất sắp tới), đặt \"adjusted\": true và ghi \"note\" giải thích ngắn (vd: 'Giờ này hôm nay đã qua nên xếp sang ngày mai'). " +
        "Nếu người dùng nói RÕ 'hôm nay' nhưng giờ đã qua, vẫn đặt hôm nay, \"adjusted\": true và note nhắc rằng thời gian đã qua. " +
        'CHỈ trả JSON: { "events": [ { "title": string, "date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM", "type": "custom|study|rest", "adjusted": boolean, "note": string } ] }. ' +
        "Nếu không rõ giờ kết thúc, đặt end = start + 60 phút. Nếu không rõ ngày (và không rơi vào quy tắc giờ đã qua), dùng hôm nay.";
    const prompt = `${nowContext()}\nHôm nay: ${today}. Ngày mai: ${tomorrow}. Giờ hiện tại: ${hhmm}.\nCâu của sinh viên: "${text}"\nChỉ trả JSON.`;
    const data = await askJson(prompt, { system, temperature: 0.2 });
    const events = Array.isArray(data.events) ? data.events : data.date ? [data] : [];
    // Backstop tầng code: đánh dấu sự kiện VẪN nằm trong quá khứ để UI cảnh báo (đề phòng AI xếp sai).
    return events.map((ev) => ({ ...ev, past: isPastEvent(ev, now) }));
}

async function examPlan(examId) {
    const exam = store.get("exams", examId);
    if (!exam) throw new Error("Không tìm thấy lịch thi.");
    const today = new Date().toISOString().slice(0, 10);
    const days = Math.max(0, Math.round((new Date(exam.date) - new Date(today)) / 86400000));
    const relatedDocs = store
        .all("documents")
        .filter((d) => (d.name || "").toLowerCase().includes(String(exam.course || "").toLowerCase()))
        .map((d) => d.summary || d.name);

    const system =
        "Bạn là cố vấn học tập. Lập lộ trình ôn thi chia theo tuần/ngày, thực tế và cụ thể, bằng tiếng Việt. " +
        'CHỈ trả JSON: { "summary": string, "phases": [ { "label": string, "range": string, "tasks": [string] } ] }';
    const prompt =
        `Môn thi: ${exam.course}. Ngày thi: ${exam.date}. Còn ${days} ngày.\n` +
        (relatedDocs.length ? `Tài liệu liên quan:\n- ${relatedDocs.join("\n- ")}\n` : "") +
        "Hãy lập lộ trình ôn. Chỉ trả JSON.";
    const data = await askJson(prompt, { system, temperature: 0.4 });
    return { exam, days, summary: data.summary || "", phases: Array.isArray(data.phases) ? data.phases : [] };
}

async function summarizeDocument(name, text) {
    const clipped = String(text || "").slice(0, 18000);
    const system =
        "Bạn tóm tắt tài liệu học tập bằng tiếng Việt. " +
        'CHỈ trả JSON: { "summary": string, "keywords": [string], "suggestions": [string] }. ' +
        "summary ngắn gọn theo ý chính; keywords là các khái niệm cốt lõi; suggestions là 3-5 việc nên làm để nắm vững.";
    const prompt = `Tên tài liệu: ${name}\nNội dung:\n"""${clipped}"""\nChỉ trả JSON.`;
    const data = await askJson(prompt, { system, temperature: 0.3 });
    return {
        summary: data.summary || "",
        keywords: Array.isArray(data.keywords) ? data.keywords : [],
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    };
}

async function suggestPractice(doc) {
    const system =
        "Bạn là gia sư. Dựa trên tài liệu sinh viên đã học, đề xuất một số bài tập/câu hỏi luyện tập kèm gợi ý lời giải ngắn, bằng tiếng Việt.";
    const prompt = `Tài liệu: ${doc.name}\nTóm tắt: ${doc.summary || ""}\nKeyword: ${(doc.keywords || []).join(", ")}\nHãy đề xuất 4-6 bài luyện tập từ dễ đến khó.`;
    return ask(prompt, { system, temperature: 0.6 });
}

// Hướng dẫn giọng văn/nội dung theo TỪNG loại lý do nghỉ.
const LEAVE_REASON_GUIDE = {
    sick: "Loại: NGHỈ ỐM/BỆNH. Trình bày lễ phép rằng do vấn đề sức khỏe không thể tới lớp; nếu có giấy/ảnh khám bệnh thì nhắc đã đính kèm để làm minh chứng.",
    family: "Loại: VIỆC GIA ĐÌNH. Nêu có việc gia đình quan trọng cần giải quyết; giữ tế nhị, KHÔNG bịa chi tiết riêng tư nhạy cảm.",
    personal: "Loại: VIỆC CÁ NHÂN. Trình bày ngắn gọn, lịch sự rằng có việc cá nhân quan trọng.",
    event: "Loại: THAM GIA HOẠT ĐỘNG/SỰ KIỆN (thi đấu, tình nguyện, công tác Đoàn/CLB...). Nêu tên hoạt động; nếu có giấy triệu tập/xác nhận thì nhắc đã đính kèm.",
    accident: "Loại: SỰ CỐ NGOÀI Ý MUỐN (kẹt xe, hỏng xe, thời tiết, sự cố nhỏ...). Giải thích khách quan, chân thành.",
    other: "Loại: LÝ DO KHÁC. Bám theo mô tả lý do của sinh viên, viết trang trọng, hợp lý.",
};

async function draftLeaveEmail(payload) {
    const s = store.getSettings();
    const student = s.student || {};
    const reasonType = String(payload.reasonType || "other").toLowerCase();
    const guide = LEAVE_REASON_GUIDE[reasonType] || LEAVE_REASON_GUIDE.other;

    const system =
        "Bạn soạn ĐƠN XIN PHÉP NGHỈ HỌC trang trọng, đúng chuẩn mực sinh viên - giảng viên đại học Việt Nam, bằng tiếng Việt. " +
        'CHỈ trả JSON: { "subject": string, "body": string }. ' +
        "Tiêu đề dạng: \"Đơn xin phép nghỉ học - <Họ tên> - <MSSV>\". " +
        "BODY phải đúng bố cục một lá đơn, gồm các phần theo thứ tự: " +
        "(1) Lời chào: 'Kính gửi: Thầy/Cô <tên giảng viên>' (kèm 'Giảng viên môn <tên môn>' nếu có); " +
        "(2) Giới thiệu bản thân: 'Em tên là <họ tên>, mã số sinh viên <MSSV>' (kèm lớp/khoa nếu có); " +
        "(3) Nội dung: em viết đơn này xin phép Thầy/Cô cho em được nghỉ buổi học môn <môn> ngày <ngày>, nêu lý do; " +
        "(4) Cam kết: hứa chép bài/hoàn thành đầy đủ nội dung và bài tập của buổi nghỉ; " +
        "(5) Minh chứng: nếu có đính kèm thì nhắc 'Em có đính kèm minh chứng kèm theo'; " +
        "(6) Lời cảm ơn và ký tên cuối thư: 'Sinh viên' rồi tên đầy đủ. " +
        "Xưng 'em', gọi 'Thầy/Cô'. Lịch sự, chân thành, không sáo rỗng, không bịa thông tin không được cung cấp. " +
        guide;

    const prompt =
        "Thông tin để viết đơn:\n" +
        `- Họ tên sinh viên: ${student.name || "(chưa có tên trong hồ sơ)"}\n` +
        `- Mã số sinh viên (MSSV): ${student.mssv || "(chưa có)"}\n` +
        `- Lớp: ${student.class || ""}\n- Khoa/Ngành: ${student.faculty || student.major || ""}\n` +
        `- Giảng viên nhận đơn: ${payload.lecturer || "(chưa rõ, dùng 'Thầy/Cô')"}\n` +
        `- Môn học/lớp học phần: ${payload.course || ""}\n` +
        `- Ngày xin nghỉ: ${payload.date || ""}\n` +
        `- Lý do (sinh viên mô tả): ${payload.reason || ""}\n` +
        `- Có đính kèm minh chứng: ${payload.hasImage ? "CÓ" : "Không"}\n` +
        "Chỉ trả JSON đúng schema.";

    const data = await askJson(prompt, { system, temperature: 0.4 });
    return { subject: data.subject || `Đơn xin phép nghỉ học - ${student.name || ""} - ${student.mssv || ""}`, body: data.body || "" };
}

// AI soạn nội dung TRẢ LỜI cho một email nhận được (dùng trong Hộp thư).
async function draftReplyEmail(payload) {
    const s = store.getSettings();
    const student = s.student || {};
    const system =
        "Bạn giúp sinh viên viết thư TRẢ LỜI email bằng tiếng Việt, lịch sự, đúng mực. " +
        'CHỈ trả JSON: { "reply": string }. ' +
        "Nội dung trả lời bám sát email gốc, xưng hô phù hợp (nếu người gửi là giảng viên/nhà trường thì 'Kính gửi Thầy/Cô', xưng 'em'). " +
        "Ngắn gọn, rõ ý, có lời chào mở đầu và ký tên cuối thư bằng tên sinh viên. Không bịa thông tin. " +
        (payload.intent ? "Ý muốn trả lời của sinh viên: " + payload.intent : "Nếu email cần xác nhận/cảm ơn thì trả lời phù hợp.");
    const prompt =
        `Sinh viên: ${student.name || ""}${student.mssv ? " (MSSV " + student.mssv + ")" : ""}\n` +
        `Email nhận được:\n- Từ: ${payload.from || ""}\n- Tiêu đề: ${payload.subject || ""}\n- Nội dung:\n"""${String(payload.body || "").slice(0, 4000)}"""\n\n` +
        "Hãy viết nội dung trả lời. Chỉ trả JSON.";
    const data = await askJson(prompt, { system, temperature: 0.5 });
    return { reply: (data && data.reply) || "" };
}

// Phân loại 1 loạt email bằng AI -> nhãn danh mục + mức quan trọng.
const MAIL_CATEGORIES = ["Học tập", "Bài tập/Deadline", "Thông báo trường", "Học phí/Tài chính", "Cá nhân", "Quảng cáo/Spam", "Khác"];
async function classifyEmails(messages) {
    const list = (Array.isArray(messages) ? messages : []).slice(0, 40).map((m) => ({ id: m.id, subject: String(m.subject || "").slice(0, 160), from: String(m.from || m.fromAddress || "").slice(0, 80), preview: String(m.preview || "").slice(0, 200) }));
    if (!list.length) return [];
    const system =
        "Bạn phân loại email của sinh viên đại học. Với MỖI email, chọn 1 danh mục trong: " + MAIL_CATEGORIES.join(", ") + ". " +
        'CHỈ trả JSON: { "items": [ { "id": string, "category": string, "important": boolean } ] }. ' +
        "important=true nếu email cần chú ý/hành động sớm (deadline, lịch thi, học phí, yêu cầu từ giảng viên). Giữ nguyên id đã cho.";
    const prompt = `Danh sách email:\n${JSON.stringify(list)}\n\nPhân loại tất cả. Chỉ trả JSON.`;
    const data = await askJson(prompt, { system, temperature: 0.1 });
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    const map = {};
    for (const it of items) if (it && it.id) map[String(it.id)] = { category: MAIL_CATEGORIES.includes(it.category) ? it.category : "Khác", important: !!it.important };
    // Trả về theo đúng thứ tự đầu vào; thiếu thì để "Khác".
    return list.map((m) => ({ id: m.id, category: (map[m.id] && map[m.id].category) || "Khác", important: (map[m.id] && map[m.id].important) || false }));
}

const SCRAPE_SCHEMAS = {
    timetable: {
        collection: "courses",
        schema:
            '{ "items": [ { "name": string, "code": string, "room": string, "lecturer": string, "day": number, "start": "HH:MM", "end": "HH:MM", "mode": "offline|online" } ] }',
        note:
            "day: Thứ 2->1, Thứ 3->2, Thứ 4->3, Thứ 5->4, Thứ 6->5, Thứ 7->6, Chủ nhật->0. " +
            "mode='online' nếu là học trực tuyến/online/eLearning, ngược lại 'offline'.",
    },
    assignments: {
        collection: "assignments",
        schema:
            '{ "items": [ { "title": string, "course": string, "content": string, "deadline": "YYYY-MM-DDTHH:MM", "done": boolean } ] }',
        note: "deadline theo ISO. Nếu chỉ có ngày thì dùng YYYY-MM-DD. done=false nếu chưa nộp.",
    },
    exams: {
        collection: "exams",
        schema:
            '{ "items": [ { "course": string, "date": "YYYY-MM-DD", "session": string, "room": string, "note": string } ] }',
        note: "date theo YYYY-MM-DD. session là ca thi nếu có.",
    },
};

/**
 * Phân tích nội dung thô lấy từ portal (bảng + text) thành dữ liệu có cấu trúc.
 * @param {"timetable"|"assignments"|"exams"} kind
 * @param {object} captured { url, title, tables, text }
 */
async function parseScraped(kind, captured) {
    const spec = SCRAPE_SCHEMAS[kind];
    if (!spec) throw new Error("Loại dữ liệu không hợp lệ: " + kind);
    const tablesText = (captured.tables || [])
        .map((rows, i) => `Bảng ${i + 1}:\n` + rows.map((r) => r.join(" | ")).join("\n"))
        .join("\n\n")
        .slice(0, 16000);
    const body = tablesText || String(captured.text || "").slice(0, 16000);

    const system =
        `Bạn bóc tách dữ liệu học tập từ nội dung trang web của trường CMC. ${nowContext()} ` +
        `CHỈ trả JSON đúng schema: ${spec.schema}. ${spec.note} ` +
        "Bỏ qua nội dung không liên quan (menu, footer). Nếu không tìm thấy dữ liệu phù hợp, trả items rỗng. Không bịa.";
    const prompt =
        `Trang: ${captured.title || ""} (${captured.url || ""})\n` +
        `Loại dữ liệu cần lấy: ${kind}\n\nNỘI DUNG:\n${body}\n\nChỉ trả JSON.`;
    const data = await askJson(prompt, { system, temperature: 0.1 });
    const items = Array.isArray(data.items) ? data.items : [];
    return { collection: spec.collection, items };
}

const SCHEMA_FRAGMENTS = {
    profile: '"profile": { "name": string, "mssv": string, "dob": string, "gender": string, "class": string, "cohort": string, "major": string, "faculty": string, "email": string, "phone": string, "address": string, "cpa": number|null, "gpa": number|null, "creditsEarned": number|null, "creditsTotal": number|null }',
    courses: '"courses": [ { "name": string, "code": string, "room": string, "lecturer": string, "day": number, "start": "HH:MM", "end": "HH:MM", "mode": "offline|online" } ]',
    exams: '"exams": [ { "course": string, "date": "YYYY-MM-DD", "session": string, "room": string, "note": string } ]',
    assignments: '"assignments": [ { "title": string, "course": string, "content": string, "deadline": "YYYY-MM-DDTHH:MM", "done": boolean } ]',
    announcements: '"announcements": [ { "title": string, "date": "YYYY-MM-DD", "content": string } ]',
    materials: '"materials": [ { "title": string, "course": string, "type": string, "url": string, "note": string } ]',
    grades: '"grades": [ { "course": string, "code": string, "credits": number, "score10": number|null, "score4": number|null, "letter": string, "semester": string, "status": string } ]',
    tuition: '"tuition": [ { "semester": string, "amount": number|null, "paid": number|null, "due": number|null, "status": string } ]',
};

const CATEGORY_NOTE = {
    profile: "profile = hồ sơ sinh viên (mục #hoso): họ tên, MSSV, ngày sinh, giới tính, lớp, khóa/niên khóa, ngành, khoa, email, điện thoại, địa chỉ, GPA/CPA, tín chỉ.",
    courses: "courses = thời khóa biểu; day: Thứ 2->1 ... Thứ 7->6, CN->0; mode='online' nếu học trực tuyến.",
    exams: "exams = lịch thi; CHỈ lấy HỌC KỲ MỚI NHẤT (gần hiện tại nhất); date theo YYYY-MM-DD.",
    assignments: "assignments = bài tập/quiz/bài nộp; deadline theo ISO; done=false nếu chưa nộp.",
    announcements: "announcements = thông báo/tin của môn hoặc hệ thống.",
    materials: "materials = tài liệu/bài giảng/học liệu (type: slide|pdf|video|link|khác; url nếu có).",
    grades: "grades = bảng điểm; điểm chữ như A/B+/C.",
    tuition: "tuition = học phí; số tiền dạng số (bỏ dấu chấm/phẩy).",
};

// Từ khóa nhận biết khối chứa DỮ LIỆU THẬT (để ưu tiên, bỏ nhiễu của framework).
const DATA_KEYWORDS = [
    "hoten", "ho ten", "hovaten", "masinhvien", "mssv", "masv", "ngaysinh", "gioitinh", "lop", "nganh", "khoa",
    "email", "dienthoai", "sodienthoai", "diachi", "monhoc", "tenmon", "mamon", "phong", "giangvien", "giaovien",
    "thu", "tiet", "ngaythi", "cathi", "diem", "tinchi", "gpa", "cpa", "hocphi", "sotien", "deadline", "hannop",
    "baitap", "assignment", "quiz", "thongbao", "tieude", "noidung", "tailieu", "hoclieu", "material", "semester", "hocky",
];
function looksReadable(s) {
    return /["':]\s*["\d[{]/.test(s) || /\b(true|false|null)\b/.test(s);
}
function scoreText(s) {
    const lower = String(s).toLowerCase();
    let sc = 0;
    for (const k of DATA_KEYWORDS) if (lower.indexOf(k) !== -1) sc++;
    return sc;
}

/**
 * Phân tích dữ liệu cào được từ một portal theo ĐÚNG phạm vi (scope) cần lấy.
 * Ưu tiên khối dữ liệu đã giải mã / có cấu trúc & liên quan; bỏ nhiễu.
 */
async function parseFullPortal(portalKey, captured, scope) {
    const cats = Array.isArray(scope) && scope.length ? scope.filter((c) => SCHEMA_FRAGMENTS[c]) : Object.keys(SCHEMA_FRAGMENTS);
    const schema = "{ " + cats.map((c) => SCHEMA_FRAGMENTS[c]).join(", ") + " }";
    const notes = cats.map((c) => CATEGORY_NOTE[c]).filter(Boolean).join(" ");

    const budget = 45000;
    const blocks = [];
    for (const s of captured.decrypted || []) {
        if (String(s).length >= 30) blocks.push({ tag: "DATA (đã giải mã)", body: String(s), w: 3 });
    }
    for (const r of captured.api || []) {
        if (looksReadable(r.body)) blocks.push({ tag: "API " + (r.url || ""), body: String(r.body), w: 1.6 });
    }
    for (const p of captured.pages || []) {
        const tablesText = (p.tables || []).map((rows) => rows.map((r) => r.join(" | ")).join("\n")).join("\n---\n");
        const body = tablesText || String(p.text || "").slice(0, 4000);
        if (body.trim()) blocks.push({ tag: "TRANG " + (p.title || "") + " (" + (p.url || "") + ")", body, w: 1 });
    }
    // Điểm ưu tiên: liên quan (từ khóa) x trọng số loại + một phần độ dài.
    blocks.forEach((b) => { b.score = scoreText(b.body) * 100 * b.w + Math.min(b.body.length, 3000) / 100; });
    blocks.sort((a, b) => b.score - a.score);

    let used = 0;
    const parts = [];
    for (const b of blocks) {
        if (used >= budget) break;
        const chunk = `# ${b.tag}\n${b.body}`.slice(0, budget - used);
        parts.push(chunk);
        used += chunk.length;
    }

    const system =
        `Bạn bóc tách dữ liệu học tập của sinh viên từ nội dung cào được ở portal CMC (${portalKey}). ${nowContext()} ` +
        `CHỈ lấy đúng các mục này và trả JSON đúng schema: ${schema}. ${notes} ` +
        "Chỉ dùng dữ liệu THỰC SỰ có trong nguồn, KHÔNG suy diễn, KHÔNG bịa. Gộp mục trùng. " +
        "Bỏ qua: menu, quảng cáo, trang đăng nhập, trang đổi mật khẩu / tài khoản nhạy cảm. Mục nào không có thì để mảng rỗng.";
    const prompt = parts.length
        ? `NGUỒN DỮ LIỆU CÀO ĐƯỢC:\n\n${parts.join("\n\n")}\n\nHãy tổng hợp. Chỉ trả JSON.`
        : "Không bắt được dữ liệu. Trả JSON với tất cả mảng rỗng.";

    const data = await askJson(prompt, { system, temperature: 0.1 });
    const out = {};
    for (const c of cats) {
        if (c === "profile") out.profile = data.profile && typeof data.profile === "object" ? data.profile : {};
        else out[c] = Array.isArray(data[c]) ? data[c] : [];
    }
    return out;
}

function loadCookieFromText(text) {
    const res = geminiCookie.setCookies(text);
    store.setSettings({ ai: { cookieConfigured: res.hasRequired } });
    return res;
}

// Bắt đầu lại cuộc trò chuyện của Trợ lý AI (tạo hội thoại Gemini mới cho lượt kế tiếp).
function resetChat() {
    geminiCookie.resetConversation("assistant");
    return { ok: true };
}

// Nạp cookie từ map do Electron tự trích (khi Kết nối Gemini tự động).
// Tự chuyển provider sang "cookie" khi đã có cookie bắt buộc.
function setCookiesFromMap(map) {
    const res = geminiCookie.setCookies(map || {});
    if (res.hasRequired) {
        store.setSettings({ ai: { provider: "cookie", cookieConfigured: true } });
    }
    return res;
}

module.exports = {
    setDataDir,
    provider,
    status,
    ask,
    checkKnowledge,
    explain,
    planSchedule,
    parseNaturalSchedule,
    examPlan,
    summarizeDocument,
    suggestPractice,
    draftLeaveEmail,
    draftReplyEmail,
    classifyEmails,
    parseScraped,
    parseFullPortal,
    loadCookieFromText,
    setCookiesFromMap,
    resetChat,
    _internal: { extractJson, nowContext, addDaysISO },
};
