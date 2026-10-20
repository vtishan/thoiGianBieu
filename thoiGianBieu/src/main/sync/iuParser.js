"use strict";

/**
 * Parser TRỰC TIẾP cho cổng IU (APIS) — map thẳng field từ JSON API, KHÔNG dùng AI.
 * Cấu trúc field lấy từ dữ liệu thật đã cào:
 *   - Lịch học/thi:  mảng item { TENHOCPHAN, THU, GIOBATDAU/PHUT, GIOKETTHUC/PHUT, PHONGHOC_TEN,
 *                    GIANGVIEN, PHANLOAI("LICHHOC"|...), CATHI, NGAYHOC }
 *   - Điểm:          object { rsDiemMoiNhat:[{ DAOTAO_HOCPHAN_TEN, DAOTAO_HOCPHAN_MA, DAOTAO_HOCPHAN_HOCTRINH,
 *                    DIEM, DIEMQUYDOI, DIEMQUYDOI_TEN, DANHGIA_TEN, NAMHOC, HOCKY }] }
 *   - Hồ sơ:         item { HODEM, TEN, MASO, GIOITINH_TEN, TTLL_DIENTHOAICANHAN, TTLL_EMAILCANHAN,
 *                    DIACHICOQUANCONGTAC, LOP, NGANH, KHOAQUANLY, KHOADAOTAO, ... }
 *   - Học phí:       rsThongTin[0] { TONGKHOANPHAINOP, TONGKHOANDANOP }
 *
 * Dữ liệu bị mojibake (UTF-8 đọc nhầm Windows-1252) -> tự sửa.
 */

// Bảng Windows-1252 cho vùng 0x80-0x9F (Unicode -> byte) để sửa mojibake chuẩn.
const W1252 = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
    0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
    0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
    0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function fixMojibake(s) {
    s = String(s == null ? "" : s);
    // Dấu hiệu mojibake tiếng Việt (Ã Ä Å Æ á» áº ...).
    if (!/[ÃÄÅÆ]|Ã¡|áº|á»/.test(s)) return s;
    const bytes = [];
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp <= 0xff) bytes.push(cp);
        else if (W1252[cp] != null) bytes.push(W1252[cp]);
        else return s; // có ký tự ngoài dự đoán -> không phải mojibake thuần, giữ nguyên
    }
    try {
        return Buffer.from(bytes).toString("utf8");
    } catch {
        return s;
    }
}

function pad2(n) {
    return String(n).padStart(2, "0");
}
function num(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
}
function clean(v) {
    if (v == null) return "";
    return String(v).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function join(a, b) {
    return [clean(a), clean(b)].filter(Boolean).join(" ").trim();
}
function hm(g, p) {
    if (g == null || g === "") return "";
    return `${pad2(Number(g) || 0)}:${pad2(Number(p) || 0)}`;
}
function ddmmyyyy(s) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || ""));
    return m ? `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` : "";
}
function ymd(y, mo, d) {
    if (!y || !mo || !d) return "";
    return `${y}-${pad2(mo)}-${pad2(d)}`;
}
// THU "2"=Thứ 2(Mon)->1 ... "7"=Thứ 7(Sat)->6 ; "8"/CN->0 (Chủ nhật)
function mapThu(t) {
    const n = Number(t);
    if (!n) return null;
    if (n === 8) return 0;
    return n >= 2 && n <= 7 ? n - 1 : null;
}

function addSchedule(it, out, cSeen, eSeen) {
    const name = clean(it.TENHOCPHAN || it.DAOTAO_HOCPHAN_TEN || it.HOCPHAN_TEN) || clean(it.DANGKY_LOPHOCPHAN_TEN);
    if (!name) return;
    const start = clean(it.GIOBATDAU_HHMM || it.THOIGIANBATDAU || it.TUGIO) || hm(it.GIOBATDAU, it.PHUTBATDAU);
    const end = clean(it.GIOKETTHUC_HHMM || it.THOIGIANKETTHUC || it.DENGIO) || hm(it.GIOKETTHUC, it.PHUTKETTHUC);
    const room = clean(it.PHONGHOC_TEN || it.TENPHONGHOC || it.PHONGHOC_MA);
    const lecturer = clean(it.GIANGVIEN);
    const isExam = /THI/i.test(String(it.PHANLOAI || "")) || (it.CATHI != null && it.CATHI !== "");
    if (isExam) {
        const date = ddmmyyyy(it.NGAYHOC || it.NGAYTHI);
        const key = `${name}|${date}|${it.CATHI || ""}`;
        if (eSeen.has(key)) return;
        eSeen.add(key);
        out.exams.push({ course: name, date, session: String(it.CATHI || ""), room, note: start && end ? `${start}-${end}` : "" });
    } else {
        const day = mapThu(it.THU != null ? it.THU : it.THUHOC);
        const key = `${name}|${day}|${start}|${room}`;
        if (cSeen.has(key)) return;
        cSeen.add(key);
        out.courses.push({ name, code: "", room, lecturer, day, start, end, mode: "offline" });
    }
}

function addGrade(it, out, gSeen) {
    const course = clean(it.DAOTAO_HOCPHAN_TEN);
    if (!course) return;
    if (num(it.DIEM) == null && !it.DANHGIA_TEN) return; // bỏ dòng chương trình chưa có điểm
    const sem = it.NAMHOC != null ? `HK${it.HOCKY} (${String(it.NAMHOC).replace(/_/g, "-")})` : "";
    const key = `${course}|${sem}`;
    if (gSeen.has(key)) return;
    gSeen.add(key);
    out.grades.push({
        course,
        code: clean(it.DAOTAO_HOCPHAN_MA),
        credits: num(it.DAOTAO_HOCPHAN_HOCTRINH),
        score10: num(it.DIEM),
        score4: num(it.DIEMQUYDOI),
        letter: clean(it.DIEMQUYDOI_TEN),
        status: clean(it.DANHGIA_TEN),
        semester: sem,
    });
}

function isScheduleArray(arr) {
    const f = arr[0];
    return f && (
        f.PHANLOAI != null ||
        f.IDLICHHOC != null ||
        f.THUHOC != null ||
        ((f.THU != null || f.NGAYHOC != null || f.NGAYTHI != null) &&
            (f.TENHOCPHAN != null || f.DAOTAO_HOCPHAN_TEN != null || f.DANGKY_LOPHOCPHAN_TEN != null))
    );
}
function isGradeArray(arr) {
    const f = arr[0];
    return f && f.DIEM !== undefined && f.DAOTAO_HOCPHAN_TEN != null && f.NAMHOC !== undefined;
}
function isProfileItem(o) {
    return o && o.MASO != null && (o.HODEM != null || o.TEN != null) && (o.TTLL_EMAILCANHAN !== undefined || o.LOP !== undefined || o.NGANH !== undefined || o.DAOTAO_LOPQUANLY_N1_TEN !== undefined);
}

function buildProfile(list) {
    // Chọn object hồ sơ nhiều trường nhất.
    let best = null;
    let bestScore = -1;
    for (const o of list) {
        const sc = Object.keys(o).length;
        if (sc > bestScore) { best = o; bestScore = sc; }
    }
    const p = {};
    const set = (k, v) => { const s = clean(v); if (s && !p[k]) p[k] = s; };
    for (const d of list) {
        set("name", join(d.HODEM, d.TEN));
        set("mssv", d.MASO);
        set("dob", ddmmyyyy(d.QLSV_NGUOIHOC_NGAYSINH || d.NGAYSINH) || ymd(d.NGAYSINH_NAM, d.NGAYSINH_THANG, d.NGAYSINH_NGAY));
        set("gender", d.GIOITINH_TEN);
        set("phone", d.TTLL_DIENTHOAICANHAN);
        set("email", d.TTLL_EMAILCANHAN);
        set("address", d.DIACHICOQUANCONGTAC || d.NOIOHIENNAY);
        set("class", d.LOP || d.DAOTAO_LOPQUANLY_N1_TEN);
        set("major", d.NGANH || d.NGANHHOC_N1_TEN);
        set("faculty", d.KHOAQUANLY);
        set("cohort", d.KHOADAOTAO || d.KHOAHOC_N1_TEN);
    }
    void best;
    return p;
}

function addTuition(r, out) {
    const amount = num(r.TONGKHOANPHAINOP);
    const paid = num(r.TONGKHOANDANOP);
    if (amount == null && paid == null) return;
    const due = Math.max(0, (amount || 0) - (paid || 0));
    out.tuition.push({
        semester: "Tổng cộng",
        amount,
        paid,
        due,
        status: due <= 0 ? "Đã đóng đủ" : "Còn nợ",
    });
}

/**
 * Phân tích các block đã giải mã (mảng chuỗi JSON) từ IU thành dữ liệu chuẩn.
 * @param {string[]} blocks captured.decrypted
 */
function parseIu(blocks) {
    const out = { profile: {}, courses: [], exams: [], grades: [], tuition: [] };
    const cSeen = new Set();
    const eSeen = new Set();
    const gSeen = new Set();
    const profileItems = [];

    for (const raw of blocks || []) {
        const fixed = fixMojibake(raw);
        let data;
        try {
            data = JSON.parse(fixed);
        } catch {
            continue;
        }

        // API IU thường bọc kết quả trong Data hoặc các object rs*. Duyệt đệ quy
        // để không bỏ lịch chỉ vì backend đổi thêm một lớp envelope.
        const arrays = [];
        const visit = (value, depth = 0) => {
            if (depth > 6 || value == null) return;
            if (Array.isArray(value)) {
                if (value.length && value.some((x) => x && typeof x === "object")) arrays.push(value);
                for (const x of value) if (x && typeof x === "object" && !Array.isArray(x)) visit(x, depth + 1);
            } else if (typeof value === "object") {
                for (const v of Object.values(value)) visit(v, depth + 1);
            }
        };
        visit(data);

        for (const arr of arrays) {
            if (!arr.length) continue;
            if (isScheduleArray(arr)) for (const it of arr) addSchedule(it, out, cSeen, eSeen);
            else if (isGradeArray(arr)) for (const it of arr) addGrade(it, out, gSeen);
            else if (isProfileItem(arr[0])) profileItems.push(arr[0]);
        }
    }

    out.profile = buildProfile(profileItems);
    return out;
}

module.exports = { parseIu, fixMojibake, _internal: { mapThu, ddmmyyyy, hm } };
