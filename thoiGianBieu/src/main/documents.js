"use strict";

/**
 * Đọc nội dung tài liệu sinh viên upload (PDF, TXT, MD) để làm ngữ cảnh cho AI.
 * pdf-parse được nạp trễ (lazy) và bọc try/catch để lỗi thư viện không làm sập app.
 */

const fs = require("fs");
const path = require("path");

async function extractPdf(buffer) {
    try {
        // Nạp trễ để tránh lỗi khởi tạo khi module có vấn đề.
        const pdfParse = require("pdf-parse");
        const data = await pdfParse(buffer);
        return String(data.text || "").trim();
    } catch (err) {
        return `__ERROR__: Không đọc được PDF (${err && err.message}).`;
    }
}

async function extractText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".pdf") {
        const buf = fs.readFileSync(filePath);
        return extractPdf(buf);
    }
    if ([".txt", ".md", ".markdown", ".csv", ".json"].includes(ext)) {
        try {
            return fs.readFileSync(filePath, "utf8");
        } catch (err) {
            return `__ERROR__: Không đọc được file (${err && err.message}).`;
        }
    }
    if ([".docx"].includes(ext)) {
        return "__ERROR__: Chưa hỗ trợ đọc nội dung .docx (hãy chuyển sang PDF hoặc TXT).";
    }
    return "__ERROR__: Định dạng chưa hỗ trợ. Hỗ trợ: PDF, TXT, MD.";
}

function typeOf(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace(".", "");
    return ext || "file";
}

async function readDocument(filePath) {
    const name = path.basename(filePath);
    const text = await extractText(filePath);
    const ok = !String(text).startsWith("__ERROR__");
    return {
        name,
        path: filePath,
        type: typeOf(filePath),
        text: ok ? text : "",
        error: ok ? null : String(text).replace("__ERROR__: ", ""),
    };
}

module.exports = { readDocument, extractText };
