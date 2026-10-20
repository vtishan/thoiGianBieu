"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, Notification } = require("electron");

const store = require("./src/main/store");
const { registerIpc } = require("./src/main/ipc");
const { Scheduler } = require("./src/main/scheduler");

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else fs.copyFileSync(s, d);
    }
}

// ===== Dữ liệu lưu trong THƯ MỤC NGƯỜI DÙNG của máy (userData mặc định), KHÔNG nằm trong project =====
// Nhờ đó: chép/đem app đi đâu cũng KHÔNG mang theo dữ liệu; máy nào chưa có dữ liệu = app mới hoàn toàn.
// (Bản trước lỡ lưu vào <project>/data -> tự khôi phục về thư mục user rồi DỌN SẠCH folder data trong project.)
(function keepDataInUserFolder() {
    try {
        const userDataDir = app.getPath("userData"); // %APPDATA%\<app> — thuộc hồ sơ người dùng của máy
        const projectData = path.join(__dirname, "data");
        const pCfg = path.join(projectData, "app-config.json");
        if (fs.existsSync(pCfg)) {
            const aCfg = path.join(userDataDir, "app-config.json");
            const pTime = fs.statSync(pCfg).mtimeMs;
            const aTime = fs.existsSync(aCfg) ? fs.statSync(aCfg).mtimeMs : 0;
            if (pTime > aTime) { // dữ liệu trong project mới hơn -> khôi phục về thư mục user
                fs.mkdirSync(userDataDir, { recursive: true });
                fs.copyFileSync(pCfg, aCfg);
                const pStudents = path.join(projectData, "students");
                if (fs.existsSync(pStudents)) copyDirSync(pStudents, path.join(userDataDir, "students"));
            }
            // Chỉ dọn folder data trong project SAU KHI chắc chắn dữ liệu đã nằm ở thư mục user.
            if (fs.existsSync(aCfg)) {
                try { fs.rmSync(projectData, { recursive: true, force: true }); } catch { /* file có thể đang khoá, bỏ qua */ }
            }
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[data] khôi phục dữ liệu về thư mục user lỗi:", err && err.message);
    }
})();

let mainWindow = null;
let scheduler = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        title: "CMC Smart Student Assistant",
        icon: fs.existsSync(path.join(__dirname, "build", "icon.png")) ? path.join(__dirname, "build", "icon.png") : undefined,
        backgroundColor: "#f6f8ff",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, "src", "renderer", "index.html"));

    // Mở link ngoài bằng trình duyệt hệ thống, không mở trong app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            require("electron").shell.openExternal(url);
            return { action: "deny" };
        }
        return { action: "allow" };
    });

    // Phím tắt: F5 / Ctrl+R = tải lại giao diện (bỏ cache) để thấy thay đổi ngay; F12 = DevTools.
    mainWindow.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const key = (input.key || "").toLowerCase();
        if (key === "f5" || (input.control && key === "r")) {
            mainWindow.webContents.reloadIgnoringCache();
            event.preventDefault();
        } else if (key === "f12") {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    return mainWindow;
}

function bootstrap() {
    // Khởi tạo kho dữ liệu cục bộ trong thư mục userData của app.
    store.init(app.getPath("userData"));

    createWindow();

    // Đăng ký toàn bộ IPC handler (store, AI, sync, docx, tài liệu, mail...).
    registerIpc({
        getWindow: () => mainWindow,
        notify: (title, body) => showNotification(title, body),
    });

    // Bộ lập lịch nhắc nhở: quét dữ liệu định kỳ và bắn thông báo.
    scheduler = new Scheduler({
        onFire: (payload) => {
            showNotification(payload.title, payload.body);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("reminder:fired", payload);
            }
        },
    });
    scheduler.start();
}

function showNotification(title, body) {
    try {
        if (Notification.isSupported()) {
            const n = new Notification({ title: String(title || "Nhắc nhở"), body: String(body || "") });
            n.on("click", () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            });
            n.show();
        }
    } catch {
        /* bỏ qua lỗi thông báo */
    }
}

app.whenReady().then(bootstrap);

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
    if (scheduler) scheduler.stop();
    if (process.platform !== "darwin") app.quit();
});
