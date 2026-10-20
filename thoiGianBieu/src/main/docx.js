"use strict";

/**
 * Xuất ghi chú textbook ra file .docx bằng thư viện "docx".
 */

const fs = require("fs");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require("docx");

function contentToParagraphs(content) {
    const paras = [];
    const lines = String(content || "").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trimEnd();
        if (/^#{1,3}\s+/.test(trimmed)) {
            const level = (trimmed.match(/^#+/)[0].length);
            paras.push(
                new Paragraph({
                    text: trimmed.replace(/^#+\s+/, ""),
                    heading: level === 1 ? HeadingLevel.HEADING_2 : level === 2 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
                })
            );
        } else if (/^\s*[-*]\s+/.test(trimmed)) {
            paras.push(new Paragraph({ text: trimmed.replace(/^\s*[-*]\s+/, ""), bullet: { level: 0 } }));
        } else if (trimmed === "") {
            paras.push(new Paragraph({ text: "" }));
        } else {
            paras.push(new Paragraph({ children: [new TextRun(trimmed)] }));
        }
    }
    if (paras.length === 0) paras.push(new Paragraph({ text: "" }));
    return paras;
}

function entryToBlock(entry) {
    const blocks = [];
    blocks.push(new Paragraph({ text: entry.title || "Ghi chú", heading: HeadingLevel.HEADING_1 }));
    const meta = [];
    if (Array.isArray(entry.tags) && entry.tags.length) meta.push(`Thẻ: ${entry.tags.join(", ")}`);
    if (entry.updatedAt) meta.push(`Cập nhật: ${new Date(entry.updatedAt).toLocaleString("vi-VN")}`);
    if (meta.length) {
        blocks.push(new Paragraph({ children: [new TextRun({ text: meta.join("  •  "), italics: true, color: "666666" })] }));
    }
    blocks.push(...contentToParagraphs(entry.content));
    return blocks;
}

async function writeDoc(children, filePath, title) {
    const doc = new Document({
        creator: "CMC Smart Student Assistant",
        title: title || "Textbook",
        sections: [
            {
                properties: {},
                children: [
                    new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new TextRun({ text: title || "Sổ tay học tập", bold: true, size: 36 })],
                    }),
                    new Paragraph({ text: "" }),
                    ...children,
                ],
            },
        ],
    });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function exportEntry(entry, filePath) {
    return writeDoc(entryToBlock(entry), filePath, entry.title || "Ghi chú");
}

async function exportEntries(entries, filePath) {
    const children = [];
    entries.forEach((entry, idx) => {
        if (idx > 0) children.push(new Paragraph({ text: "", pageBreakBefore: true }));
        children.push(...entryToBlock(entry));
    });
    return writeDoc(children, filePath, "Sổ tay học tập - Tổng hợp");
}

module.exports = { exportEntry, exportEntries };
