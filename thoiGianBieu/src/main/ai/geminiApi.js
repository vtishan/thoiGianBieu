"use strict";

/**
 * Provider gọi Gemini qua API key CHÍNH THỨC (Google AI Studio / Generative Language API).
 * Ổn định hơn nhiều so với cách dùng cookie. Lấy key miễn phí tại: https://aistudio.google.com/apikey
 */

const axios = require("axios");

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 60 * 1000;

class AiError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "AiError";
        this.code = code || "AI_ERROR";
    }
}

/**
 * Gọi Gemini.
 * @param {object} cfg { apiKey, model }
 * @param {string} prompt câu hỏi hiện tại
 * @param {object} [opts] { system, history: [{role:'user'|'model', text}], temperature, json }
 * @returns {Promise<string>} văn bản trả về
 */
async function ask(cfg, prompt, opts = {}) {
    const apiKey = String(cfg && cfg.apiKey || "").trim();
    if (!apiKey) throw new AiError("Chưa cấu hình khóa truy cập cho dịch vụ AI.", "AI_NO_KEY");
    const model = String(cfg && cfg.model || "gemini-2.5-flash").trim();

    const contents = [];
    for (const turn of opts.history || []) {
        if (!turn || !turn.text) continue;
        contents.push({ role: turn.role === "model" ? "model" : "user", parts: [{ text: String(turn.text) }] });
    }
    contents.push({ role: "user", parts: [{ text: String(prompt || "") }] });

    const body = {
        contents,
        generationConfig: {
            temperature: typeof opts.temperature === "number" ? opts.temperature : 0.7,
        },
    };
    if (opts.system) {
        body.systemInstruction = { parts: [{ text: String(opts.system) }] };
    }
    if (opts.json) {
        body.generationConfig.responseMimeType = "application/json";
    }

    const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let res;
    try {
        res = await axios.post(url, body, {
            timeout: TIMEOUT_MS,
            validateStatus: (s) => s >= 200 && s < 500,
            headers: { "Content-Type": "application/json" },
        });
    } catch (err) {
        throw new AiError(`Lỗi mạng khi gọi dịch vụ AI: ${err && err.message}`, "AI_NETWORK");
    }

    if (res.status === 400) {
        throw new AiError("Yêu cầu AI không hợp lệ. Hãy kiểm tra lại cấu hình dịch vụ.", "AI_BAD_REQUEST");
    }
    if (res.status === 401 || res.status === 403) {
        throw new AiError("Khóa truy cập AI không hợp lệ hoặc bị từ chối.", "AI_AUTH");
    }
    if (res.status === 404) {
        throw new AiError("Không tìm thấy mô hình AI đã cấu hình. Hãy kiểm tra lại Cài đặt.", "AI_MODEL");
    }
    if (res.status === 429) {
        throw new AiError("Dịch vụ AI đang vượt hạn mức (429). Hãy thử lại sau ít phút.", "AI_RATE");
    }

    const data = res.data || {};
    const cand = data.candidates && data.candidates[0];
    if (!cand) {
        const block = data.promptFeedback && data.promptFeedback.blockReason;
        if (block) throw new AiError(`Nội dung bị chặn: ${block}.`, "AI_BLOCKED");
        throw new AiError("Dịch vụ AI không trả về nội dung.", "AI_EMPTY");
    }
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || "").join("").trim();
    if (!text) throw new AiError("Dịch vụ AI trả về nội dung rỗng.", "AI_EMPTY");
    return text;
}

async function verify(cfg) {
    const out = await ask(cfg, "Trả lời đúng một từ: OK", { temperature: 0 });
    return /ok/i.test(out);
}

module.exports = { ask, verify, AiError };
