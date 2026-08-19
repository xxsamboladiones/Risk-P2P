import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const DEVELOPMENT_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const DESKTOP_HOST = "127.0.0.1";
const DESKTOP_PORT = 5173;
const DESKTOP_ORIGIN = "http://localhost:5173";
let assetServer: Server | undefined;
let pageUrl = DESKTOP_ORIGIN;

function isTrustedRendererUrl(value: string): boolean {
  try {
    const origin = new URL(value).origin;
    return app.isPackaged ? origin === DESKTOP_ORIGIN : DEVELOPMENT_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function startPackagedWebServer(): Promise<string> {
  if (assetServer) return DESKTOP_ORIGIN;
  const webRoot = path.resolve(process.resourcesPath, "web");
  assetServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", DESKTOP_ORIGIN);
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
      const filePath = path.resolve(webRoot, relativePath);
      if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": contentType(filePath),
        "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    assetServer!.once("error", reject);
    assetServer!.listen(DESKTOP_PORT, DESKTOP_HOST, () => {
      assetServer!.off("error", reject);
      resolve();
    });
  });
  return DESKTOP_ORIGIN;
}

ipcMain.handle("screen:list", async (event) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  return (await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  })).map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    thumbnail: source.thumbnail.toDataURL(),
  }));
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#090b10",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(pageUrl).catch((error) => {
    console.error("Falha ao carregar a interface do Risk", error);
    window.show();
  });
}

app.whenReady().then(async () => {
  pageUrl = app.isPackaged ? await startPackagedWebServer() : DESKTOP_ORIGIN;
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrustedRendererUrl(webContents.getURL()) && ["media", "display-capture"].includes(permission));
  });
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}).catch((error) => {
  console.error("Falha ao iniciar o Risk", error);
  app.quit();
});

app.on("before-quit", () => {
  assetServer?.close();
  assetServer = undefined;
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
