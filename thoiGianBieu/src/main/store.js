"use strict";

/**
 * Kho dữ liệu cục bộ ĐA HỒ SƠ (local-first).
 *
 * Mỗi sinh viên = một folder riêng để dữ liệu KHÔNG lẫn giữa các tài khoản:
 *   <userData>/students/<key>/data.json   (key = email sinh viên, đã chuẩn hoá)
 *   <userData>/app-config.json            (cấu hình chung: AI, giao diện, danh sách sinh viên, sinh viên đang xem)
 *
 * Định danh & so sánh tài khoản bằng MÃ SINH VIÊN (MSSV). Khi cào được hồ sơ,
 * app tự chọn đúng folder theo MSSV (tạo mới nếu là tài khoản khác).
 *
 * Dữ liệu mỗi sinh viên: student(hồ sơ), mail, portal + các collection:
 *   courses, assignments, exams, events, documents, textbook, reminders,
 *   grades, tuition, announcements, materials.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const COLLECTIONS = ["courses", "assignments", "exams", "events", "documents", "textbook", "reminders", "grades", "tuition", "announcements", "materials"];

const DEFAULT_STUDENT = {
    name: "", mssv: "", dob: "", gender: "", email: "", phone: "", address: "",
    class: "", cohort: "", major: "", faculty: "",
    cpa: null, gpa: null, creditsEarned: null, creditsTotal: null,
};
const DEFAULT_MAIL = { service: "gmail", host: "", port: 465, secure: true, user: "", pass: "" };
const DEFAULT_PORTAL = { username: "", loggedIn: false, loginAt: 0, lastSync: 0 };
const DEFAULT_AI = { provider: "cookie", apiKey: "", model: "gemini-2.5-flash", cookieConfigured: false };
// Model cũ -> tự nâng lên bản mới hơn khi nạp cấu hình (app không có UI chọn model).
const MODEL_UPGRADE = { "gemini-2.0-flash": "gemini-2.5-flash", "gemini-1.5-flash": "gemini-2.5-flash", "gemini-1.5-pro": "gemini-2.5-pro", "gemini-pro": "gemini-2.5-flash" };
const DEFAULT_UI = { theme: "light" };

const DEFAULT_GLOBAL = { activeKey: "", students: [], settings: { ai: clone(DEFAULT_AI), ui: clone(DEFAULT_UI) } };

let dataDir = null;
let studentsDir = null;
let configFile = null;
let globalCfg = null; // { activeKey, students:[{key,email,mssv,name}], settings:{ai,ui} }
let activeKey = null;
let db = null; // { student, mail, portal, <collections> }

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}
function deepMerge(target, source) {
    if (!source || typeof source !== "object") return target;
    for (const [k, v] of Object.entries(source)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
            target[k] = deepMerge(target[k] && typeof target[k] === "object" ? target[k] : {}, v);
        } else {
            target[k] = v;
        }
    }
    return target;
}
function writeAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
}

// ===== Khởi tạo =====
function init(userDataDir) {
    dataDir = userDataDir;
    studentsDir = path.join(dataDir, "students");
    configFile = path.join(dataDir, "app-config.json");
    fs.mkdirSync(studentsDir, { recursive: true });
    loadGlobal();
    migrateOldData();
    activeKey = globalCfg.activeKey || "default";
    loadStudent(activeKey);
    return db;
}

function loadGlobal() {
    try {
        const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
        globalCfg = clone(DEFAULT_GLOBAL);
        globalCfg.activeKey = parsed.activeKey || "";
        globalCfg.students = Array.isArray(parsed.students) ? parsed.students : [];
        globalCfg.settings.ai = deepMerge(clone(DEFAULT_AI), (parsed.settings && parsed.settings.ai) || {});
        globalCfg.settings.ui = deepMerge(clone(DEFAULT_UI), (parsed.settings && parsed.settings.ui) || {});
        // Tự nâng model cũ lên bản mới hơn (nếu người dùng chưa từng đổi thủ công).
        if (MODEL_UPGRADE[globalCfg.settings.ai.model]) globalCfg.settings.ai.model = MODEL_UPGRADE[globalCfg.settings.ai.model];
    } catch {
        globalCfg = clone(DEFAULT_GLOBAL);
        persistGlobal();
    }
}
function persistGlobal() {
    try {
        writeAtomic(configFile, globalCfg);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[store] không ghi được app-config:", err && err.message);
    }
}

// Di trú 1 lần: file dữ liệu cũ (gộp chung mọi tài khoản) -> giữ cấu hình AI, bỏ dữ liệu trộn lẫn.
function migrateOldData() {
    const oldFile = path.join(dataDir, "cmc-assistant-data.json");
    if (!fs.existsSync(oldFile)) return;
    try {
        const old = JSON.parse(fs.readFileSync(oldFile, "utf8"));
        if (old.settings && old.settings.ai) {
            globalCfg.settings.ai = deepMerge(globalCfg.settings.ai, old.settings.ai);
            persistGlobal();
        }
    } catch {
        /* ignore */
    }
    // Đổi tên (sao lưu) file cũ để app không dùng dữ liệu không đúng tài khoản nữa.
    try {
        fs.renameSync(oldFile, oldFile + ".bak-" + Date.now());
    } catch {
        /* ignore */
    }
}

function studentFile(key) {
    return path.join(studentsDir, key, "data.json");
}
function defaultStudentDb() {
    const base = { student: clone(DEFAULT_STUDENT), mail: clone(DEFAULT_MAIL), portal: clone(DEFAULT_PORTAL) };
    for (const c of COLLECTIONS) base[c] = [];
    return base;
}
function loadStudent(key) {
    activeKey = key;
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(studentFile(key), "utf8"));
    } catch {
        parsed = null;
    }
    db = defaultStudentDb();
    if (parsed) {
        db.student = deepMerge(db.student, parsed.student || {});
        db.mail = deepMerge(db.mail, parsed.mail || {});
        db.portal = deepMerge(db.portal, parsed.portal || {});
        for (const c of COLLECTIONS) db[c] = Array.isArray(parsed[c]) ? parsed[c] : [];
    } else {
        persistStudent();
    }
    return db;
}
function persistStudent() {
    try {
        writeAtomic(studentFile(activeKey), db);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[store] không ghi được dữ liệu sinh viên:", err && err.message);
    }
}

// ===== Quản lý hồ sơ sinh viên =====
function sanitizeKey(email, mssv) {
    const e = String(email || "").trim().toLowerCase();
    if (e) return e.replace(/[^a-z0-9._@+-]/g, "_");
    const m = String(mssv || "").trim();
    if (m) return "mssv-" + m.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return "default";
}
function findStudentByMssv(mssv) {
    const m = String(mssv || "").trim().toLowerCase();
    if (!m) return null;
    return globalCfg.students.find((s) => String(s.mssv || "").trim().toLowerCase() === m) || null;
}

/**
 * Đảm bảo có folder cho sinh viên theo hồ sơ. SO SÁNH BẰNG MSSV.
 * Trả về key (dùng để setActiveStudent).
 */
function ensureStudentByProfile(profile) {
    const email = String((profile && profile.email) || "").trim();
    const mssv = String((profile && profile.mssv) || "").trim();
    if (!email && !mssv) return activeKey; // không đủ thông tin -> giữ nguyên

    let entry = findStudentByMssv(mssv);
    if (!entry) {
        const key = sanitizeKey(email, mssv);
        entry = globalCfg.students.find((s) => s.key === key) || null;
        if (!entry) {
            entry = { key, email, mssv, name: (profile && profile.name) || "" };
            globalCfg.students.push(entry);
        }
    }
    if (email) entry.email = email;
    if (mssv) entry.mssv = mssv;
    if (profile && profile.name) entry.name = profile.name;
    persistGlobal();
    return entry.key;
}

function setActiveStudent(key) {
    if (!key || key === activeKey) {
        if (key === activeKey && globalCfg.activeKey !== key) { globalCfg.activeKey = key; persistGlobal(); }
        return activeKey;
    }
    persistStudent(); // lưu hồ sơ hiện tại trước khi chuyển
    globalCfg.activeKey = key;
    persistGlobal();
    loadStudent(key);
    return activeKey;
}

function getStudents() {
    return { activeKey, students: clone(globalCfg.students) };
}

// ===== CRUD collection =====
function ensureInit() {
    if (!db) throw new Error("Store chưa init. Gọi store.init(userDataDir) trước.");
}
function assertCollection(collection) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`Collection không hợp lệ: ${collection}`);
}
function all(collection) {
    ensureInit();
    assertCollection(collection);
    return clone(db[collection]);
}
function get(collection, id) {
    ensureInit();
    assertCollection(collection);
    const found = db[collection].find((x) => x.id === id);
    return found ? clone(found) : null;
}
function add(collection, item) {
    ensureInit();
    assertCollection(collection);
    const now = Date.now();
    const record = { ...item, id: item && item.id ? item.id : crypto.randomUUID(), createdAt: now, updatedAt: now };
    db[collection].push(record);
    persistStudent();
    return clone(record);
}
function update(collection, id, patch) {
    ensureInit();
    assertCollection(collection);
    const idx = db[collection].findIndex((x) => x.id === id);
    if (idx === -1) return null;
    db[collection][idx] = { ...db[collection][idx], ...patch, id, updatedAt: Date.now() };
    persistStudent();
    return clone(db[collection][idx]);
}
function remove(collection, id) {
    ensureInit();
    assertCollection(collection);
    const before = db[collection].length;
    db[collection] = db[collection].filter((x) => x.id !== id);
    const changed = db[collection].length !== before;
    if (changed) persistStudent();
    return changed;
}
function clearCollection(collection) {
    ensureInit();
    assertCollection(collection);
    db[collection] = [];
    persistStudent();
    return true;
}
function replaceBySource(collection, source, items) {
    ensureInit();
    assertCollection(collection);
    const kept = db[collection].filter((x) => x.source !== source);
    const now = Date.now();
    const added = (items || []).map((it) => ({ ...it, id: it.id || crypto.randomUUID(), source, createdAt: now, updatedAt: now }));
    db[collection] = [...kept, ...added];
    persistStudent();
    return added.length;
}

// ===== Settings (kết hợp: student/mail/portal theo sinh viên + ai/ui chung) =====
function getSettings() {
    ensureInit();
    return clone({
        student: db.student,
        mail: db.mail,
        portal: db.portal,
        ai: globalCfg.settings.ai,
        ui: globalCfg.settings.ui,
        _activeKey: activeKey,
    });
}
function setSettings(patch) {
    ensureInit();
    patch = patch || {};
    let g = false;
    let s = false;
    if (patch.ai) { globalCfg.settings.ai = deepMerge(globalCfg.settings.ai, patch.ai); g = true; }
    if (patch.ui) { globalCfg.settings.ui = deepMerge(globalCfg.settings.ui, patch.ui); g = true; }
    if (patch.student) { db.student = deepMerge(db.student, patch.student); s = true; }
    if (patch.mail) { db.mail = deepMerge(db.mail, patch.mail); s = true; }
    if (patch.portal) { db.portal = deepMerge(db.portal, patch.portal); s = true; }
    if (g) persistGlobal();
    if (s) persistStudent();
    return getSettings();
}

/**
 * Xoá toàn bộ dữ liệu học tập của sinh viên ĐANG XEM (đăng xuất có xoá dữ liệu).
 * - Reset hồ sơ (student) + trạng thái portal về mặc định.
 * - Xoá sạch mọi collection (TKB, lịch thi, điểm, học phí, tài liệu, ghi chú, nhắc nhở...).
 * - GIỮ cấu hình email (mail) để không phải nhập lại App Password.
 * - GIỮ cấu hình chung (AI/giao diện) vì chúng nằm ở app-config, không thuộc hồ sơ này.
 */
function resetActiveStudent() {
    ensureInit();
    const keepMail = clone(db.mail);
    db = defaultStudentDb();
    db.mail = keepMail;
    persistStudent();
    return getSettings();
}

function getDataDir() {
    return dataDir;
}

/**
 * Xoá SẠCH TOÀN BỘ dữ liệu: mọi hồ sơ sinh viên + cấu hình chung + file debug.
 * Sau khi xoá, khởi tạo lại hồ sơ mặc định trống. (Không thể hoàn tác.)
 */
function wipeAllData() {
    try { if (fs.existsSync(studentsDir)) fs.rmSync(studentsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (fs.existsSync(configFile)) fs.rmSync(configFile, { force: true }); } catch { /* ignore */ }
    try { const dbg = path.join(dataDir, "debug"); if (fs.existsSync(dbg)) fs.rmSync(dbg, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(studentsDir, { recursive: true });
    globalCfg = clone(DEFAULT_GLOBAL);
    persistGlobal();
    activeKey = "default";
    loadStudent(activeKey);
    return true;
}

module.exports = {
    init,
    all,
    get,
    add,
    update,
    remove,
    clear: clearCollection,
    replaceBySource,
    getSettings,
    setSettings,
    resetActiveStudent,
    wipeAllData,
    getDataDir,
    getStudents,
    setActiveStudent,
    ensureStudentByProfile,
    COLLECTIONS,
};
