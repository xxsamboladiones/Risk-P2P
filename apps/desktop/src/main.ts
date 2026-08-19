import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
ipcMain.handle("screen:list", async () => (await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })).map((source) => ({ id: source.id, name: source.name, displayId: source.display_id, thumbnail: source.thumbnail.toDataURL() })));
function createWindow(): void { const window = new BrowserWindow({ width: 1280, height: 800, minWidth: 900, minHeight: 600, backgroundColor: "#090b10", webPreferences: { preload: path.join(root, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } }); const dev = process.env.NODE_ENV !== "production"; if (dev) void window.loadURL("http://localhost:5173"); else void window.loadFile(path.join(root, "../../web/dist/index.html")); }
app.whenReady().then(() => { session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(["media", "display-capture"].includes(permission))); createWindow(); app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
