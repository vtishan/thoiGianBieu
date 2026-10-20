"use strict";

/**
 * Parser cho các portal SPA gọi API trực tiếp (không DOM, không AI).
 * Map thẳng theo CẤU TRÚC THẬT đã bắt được từ req/res:
 *   - LMS (Canvas): /api/v1/planner/items + /api/v1/users/self/todo -> assignments (bài tập).
 *   - EduX: /api/subjects/joined -> materials (danh sách môn học/học liệu).
 *   - eLearning: /api/Courses/enrolled|dashboard -> materials (khóa đã ghi danh).
 *
 * results: [{ url, status, body }]  (body là chuỗi JSON)
 */

function safeParse(text) {
    try { return JSON.parse(text); } catch { return null; }
}
function asArray(j) {
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.data)) return j.data; // envelope { data: [...] }
    if (j && Array.isArray(j.items)) return j.items;
    return [];
}
function firstValue(object, paths) {
    for (const path of paths) {
        let value = object;
        for (const part of path.split(".")) value = value && value[part];
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return "";
}
function normalizeDeadline(value) {
    if (value == null || value === "") return "";
    if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
        const n = Number(value);
        const date = new Date(n < 1e12 ? n * 1000 : n);
        return isNaN(date.getTime()) ? "" : date.toISOString();
    }
    const date = new Date(value);
    return isNaN(date.getTime()) ? String(value) : date.toISOString();
}
function assignmentFrom(item, fallbackCourse = "", fallbackDeadline = "") {
    if (!item || typeof item !== "object") return null;
    const rawType = firstValue(item, ["type", "itemType", "lessonItemType", "category", "kind"]);
    const type = String(rawType).toLowerCase();
    const title = firstValue(item, [
        "title", "name", "assignmentName", "assignmentTitle", "exercise_name", "exam_name",
        "lessonItemTitle", "itemTitle", "courseLessonItemTitle", "config.title",
    ]);
    const deadline = normalizeDeadline(firstValue(item, [
        "deadline", "dueDate", "due_date", "dueAt", "closeDate", "endDate", "end_time",
        "activeTime.closeDate", "openCondition.activeTime.closeDate",
        "section.openCondition.activeTime.closeDate", "config.deadline",
    ]) || fallbackDeadline);
    // eLearning: LessonItemType 1 = Quiz, 3 = Assignment.
    const assignmentLike = /assignment|exercise|quiz|exam|bài tập|kiểm tra/.test(type) || [1, 3, "1", "3"].includes(rawType) ||
        item.assignmentId != null || item.assignment_id != null || item.exercise_id != null ||
        item.exist_exam === true || item.exist_manual_exercise === true;
    if (!title || (!assignmentLike && !deadline)) return null;
    return {
        title: String(title),
        course: String(firstValue(item, [
            "courseName", "courseTitle", "courseGroupName", "context_name", "subject_name",
            "subjectName", "subject.name", "course.name",
        ]) || (typeof item.course === "string" ? item.course : "") || fallbackCourse || ""),
        content: stripHtml(item.description || item.content || item.note || "").slice(0, 600),
        deadline,
        done: !!(item.isCompleted || item.completed || item.submitted || item.isSubmitted || item.is_submitted ||
            /submitted|completed|finished|done/i.test(String(item.status || item.submissionStatus || ""))),
        url: String(item.url || item.html_url || item.webLink || ""),
        kind: type || "assignment",
    };
}
function collectGenericAssignments(results) {
    const out = [];
    const seen = new Set();
    for (const r of results || []) {
        const j = safeParse(r && r.body);
        if (!j) continue;
        const visit = (value, inheritedCourse = "", inheritedDeadline = "", depth = 0) => {
            if (!value || depth > 10) return;
            if (Array.isArray(value)) {
                for (const item of value) visit(item, inheritedCourse, inheritedDeadline, depth + 1);
                return;
            }
            if (typeof value !== "object") return;
            const ownCourse = firstValue(value, [
                "courseName", "courseTitle", "courseGroupName", "context_name",
                "subject_name", "subjectName", "subject.name", "course.name",
            ]);
            const course = String(ownCourse || inheritedCourse || "");
            const ownDeadline = normalizeDeadline(firstValue(value, [
                "deadline", "dueDate", "due_date", "dueAt", "closeDate", "endDate", "end_time",
                "activeTime.closeDate", "openCondition.activeTime.closeDate",
                "section.openCondition.activeTime.closeDate", "config.deadline",
            ]));
            const deadline = ownDeadline || inheritedDeadline;
            const hasNestedItems = ["items", "sections", "lessons", "children", "modules"]
                .some((key) => Array.isArray(value[key]) && value[key].length);
            const marker = String(firstValue(value, ["type", "itemType", "lessonItemType", "category", "kind"])).toLowerCase();
            const explicitAssignment = /assignment|exercise|quiz|exam|bài tập|kiểm tra/.test(marker) ||
                marker === "1" || marker === "3" || value.assignmentId != null ||
                value.assignment_id != null || value.exercise_id != null;
            const a = assignmentFrom(value, course, deadline);
            if (a && !(hasNestedItems && !explicitAssignment)) {
                const key = `${a.title}|${a.course}|${a.deadline}`;
                if (!seen.has(key)) { seen.add(key); out.push(a); }
            }
            for (const child of Object.values(value)) {
                if (child && typeof child === "object") visit(child, course, deadline, depth + 1);
            }
        };
        visit(j);
    }
    return out;
}
function stripHtml(s) {
    return String(s || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
        .replace(/\s+/g, " ")
        .trim();
}

// ===== LMS (Canvas) =====
const LMS_BASE = "https://lms.cmcu.edu.vn";
function lmsUrl(u) {
    if (!u) return "";
    return /^https?:/i.test(u) ? u : LMS_BASE + u;
}

function parseLms(results) {
    const byKey = new Map();
    const upsert = (key, obj) => {
        if (!key) key = (obj.title || "") + "|" + (obj.deadline || "");
        const cur = byKey.get(key);
        if (!cur) { byKey.set(key, obj); return; }
        if (!cur.title && obj.title) cur.title = obj.title;
        if (!cur.deadline && obj.deadline) cur.deadline = obj.deadline;
        if (!cur.content && obj.content) cur.content = obj.content;
        if (!cur.url && obj.url) cur.url = obj.url;
        if (obj.done) cur.done = true;
    };

    for (const r of results || []) {
        const j = safeParse(r && r.body);
        if (!j) continue;
        const url = (r && r.url) || "";
        if (/planner\/items/i.test(url) && Array.isArray(j)) {
            for (const it of j) {
                const type = it.plannable_type;
                if (!["assignment", "quiz", "discussion_topic", "sub_assignment"].includes(type)) continue;
                const pl = it.plannable || {};
                const id = String(it.plannable_id || pl.id || "");
                upsert("id:" + id, {
                    title: pl.title || "",
                    course: it.context_name || "",
                    content: "",
                    deadline: pl.due_at || pl.todo_date || it.plannable_date || "",
                    done: !!(it.submissions && it.submissions.submitted),
                    url: lmsUrl(it.html_url),
                    kind: type,
                });
            }
        } else if (/self\/todo/i.test(url) && Array.isArray(j)) {
            for (const it of j) {
                const a = it.assignment || it.quiz || {};
                const id = String(a.id || "");
                upsert("id:" + id, {
                    title: a.name || a.title || "",
                    course: it.context_name || "",
                    content: stripHtml(a.description).slice(0, 600),
                    deadline: a.due_at || "",
                    done: false,
                    url: lmsUrl(a.html_url),
                    kind: "assignment",
                });
            }
        }
    }
    const assignments = Array.from(byKey.values()).filter((a) => a.title);
    return { assignments };
}

// ===== EduX (nền tảng học liệu AI) =====
function parseEdux(results) {
    const materials = [];
    const subjects = new Map();
    const models = new Map();
    const assignments = new Map();
    const upsert = (key, item) => {
        if (!item || !item.title) return;
        const old = assignments.get(key) || {};
        assignments.set(key, { ...old, ...item, content: item.content || old.content || "", deadline: item.deadline || old.deadline || "" });
    };
    for (const r of results || []) {
        const url = (r && r.url) || "";
        const parsed = safeParse(r && r.body);
        if (!parsed) continue;
        const arr = asArray(parsed);
        if (/subjects\/joined/i.test(url)) {
            for (const s of arr) {
                if (!s || !s.name) continue;
                subjects.set(String(s.id || ""), s.name);
                materials.push({
                    title: s.name,
                    course: s.name,
                    type: "Môn học (EduX)",
                    url: "https://edux.cmcu.edu.vn/student",
                    note: [s.subject_code, s.knowledge_count != null ? s.knowledge_count + " kiến thức" : "", s.model_count != null ? s.model_count + " mô hình" : ""].filter(Boolean).join(" • "),
                });
            }
        } else {
            const modelMatch = /subjects\/([^/]+)\/models/i.exec(url);
            if (modelMatch) for (const model of arr) {
                if (!model || !model.id) continue;
                const course = subjects.get(modelMatch[1]) || (model.subject && model.subject.name) || "";
                models.set(String(model.id), { ...model, course });
                if (model.exist_exam) {
                    upsert(`exam:${model.id}`, {
                        title: model.title || model.name || "Bài kiểm tra EduX",
                        course,
                        content: stripHtml(model.description || ""),
                        deadline: normalizeDeadline(model.deadline),
                        done: false,
                        url: `https://edux.cmcu.edu.vn/model?id=${encodeURIComponent(model.id)}`,
                        kind: "exam",
                    });
                }
                if (model.exist_manual_exercise) {
                    upsert(`manual:${model.id}`, {
                        title: model.title || model.name || "Bài tập EduX",
                        course,
                        content: stripHtml(model.description || ""),
                        deadline: normalizeDeadline(model.deadline),
                        done: false,
                        url: `https://edux.cmcu.edu.vn/model?id=${encodeURIComponent(model.id)}`,
                        kind: "exercise",
                    });
                }
            }

            const examMatch = /exam\/config\/([^/?]+)/i.exec(url);
            if (examMatch) {
                const model = models.get(examMatch[1]) || {};
                const cfg = (parsed.data && (parsed.data.config || parsed.data)) || parsed.config || parsed;
                if (cfg && (cfg.has_config !== false || cfg.title)) upsert(`exam:${examMatch[1]}`, {
                    title: cfg.title || model.title || "Bài kiểm tra EduX",
                    course: model.course || "",
                    content: stripHtml(cfg.description || model.description || ""),
                    deadline: normalizeDeadline(cfg.deadline),
                    done: false,
                    url: `https://edux.cmcu.edu.vn/model?id=${encodeURIComponent(examMatch[1])}`,
                    kind: "exam",
                });
            }

            const manualMatch = /manual-exercises\/configs\?[^#]*model_id=([^&]+)/i.exec(url);
            if (manualMatch) {
                const id = decodeURIComponent(manualMatch[1]);
                const model = models.get(id) || {};
                for (const cfg of arr) upsert(`manual:${id}`, {
                    title: cfg.title || model.title || "Bài tập EduX",
                    course: model.course || "",
                    content: stripHtml(cfg.description || model.description || ""),
                    deadline: normalizeDeadline(cfg.deadline || cfg.end_time || cfg.close_date),
                    done: false,
                    url: `https://edux.cmcu.edu.vn/model?id=${encodeURIComponent(id)}`,
                    kind: "exercise",
                });
            }

            const submissionMatch = /manual-exercises\/models\/([^/]+)\/submission/i.exec(url);
            if (submissionMatch) {
                const id = decodeURIComponent(submissionMatch[1]);
                const model = models.get(id) || {};
                const submission = parsed.data || parsed;
                const done = !!(submission && (submission.submitted_at || submission.is_submitted ||
                    /submitted|completed|graded/i.test(String(submission.status || ""))));
                const key = `manual:${id}`;
                if (assignments.has(key) && done) upsert(key, { ...assignments.get(key), done: true });
                else if (done) upsert(`manual:${id}`, {
                    title: model.title || "Bài tập EduX",
                    course: model.course || "",
                    deadline: "",
                    done: true,
                    url: `https://edux.cmcu.edu.vn/model?id=${encodeURIComponent(id)}`,
                    kind: "exercise",
                });
            }
        }
    }
    const genericResults = (results || []).filter((r) => {
        const url = (r && r.url) || "";
        if (/subjects\/joined|subjects\/[^/]+\/models|exam\/config|manual-exercises\/(configs|models\/[^/]+\/submission)/i.test(url)) return false;
        return /assignment|exercise|quiz|exam/i.test(url);
    });
    for (const item of collectGenericAssignments(genericResults)) {
        const key = `${item.title}|${item.course}|${item.deadline}`;
        const duplicate = Array.from(assignments.values()).some((old) =>
            old.title === item.title && old.course === item.course && old.deadline === item.deadline
        );
        if (!duplicate) assignments.set(key, item);
    }
    return { materials, assignments: Array.from(assignments.values()) };
}

// ===== eLearning =====
function parseElearning(results) {
    const materials = [];
    const seen = new Set();
    for (const r of results || []) {
        const url = (r && r.url) || "";
        if (!/Courses\/(enrolled|dashboard|get-all)/i.test(url)) continue;
        const arr = asArray(safeParse(r && r.body));
        for (const c of arr) {
            if (!c) continue;
            const title = c.name || c.title || c.courseName || c.displayName || "";
            if (!title || seen.has(title)) continue;
            seen.add(title);
            materials.push({
                title,
                course: title,
                type: "Khóa học (eLearning)",
                url: c.slug ? ("https://elearning.cmcu.edu.vn/course/" + c.slug) : "https://elearning.cmcu.edu.vn/",
                note: [c.code || c.courseCode || "", (c.progress != null ? "tiến độ " + c.progress + "%" : "")].filter(Boolean).join(" • "),
            });
        }
    }
    return { materials, assignments: collectGenericAssignments(results) };
}

function parseApi(parser, results) {
    if (parser === "lms") return parseLms(results);
    if (parser === "edux") return parseEdux(results);
    if (parser === "elearning") return parseElearning(results);
    return {};
}

module.exports = { parseApi, parseLms, parseEdux, parseElearning, _internal: { stripHtml, asArray } };
