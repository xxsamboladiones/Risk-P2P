import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const DEVELOPMENT_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const DESKTOP_HOST = "127.0.0.1";
const DEV_BACKEND_BRIDGE_FILE = path.resolve(root, "../../../.risk/dev-backend.json");
let assetServer: Server | undefined;
let pageUrl = "http://localhost:5173";
let packagedOrigin = "";
let pendingDisplaySourceId: string | undefined;
let backendProcess: ChildProcess | undefined;
let backendConfig: { baseUrl: string; token: string } | undefined;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function isTrustedRendererUrl(value: string): boolean {
  try {
    const origin = new URL(value).origin;
    return app.isPackaged ? origin === packagedOrigin : DEVELOPMENT_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

async function publishDevBackendBridge(config: { baseUrl: string; token: string }): Promise<void> {
  if (app.isPackaged) return;
  await mkdir(path.dirname(DEV_BACKEND_BRIDGE_FILE), { recursive: true });
  await writeFile(DEV_BACKEND_BRIDGE_FILE, JSON.stringify(config), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function clearDevBackendBridge(): Promise<void> {
  if (app.isPackaged) return;
  await unlink(DEV_BACKEND_BRIDGE_FILE).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") console.warn("Falha ao remover bridge temporário do backend", error);
  });
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
  if (assetServer && packagedOrigin) return packagedOrigin;
  const webRoot = path.resolve(process.resourcesPath, "web");
  assetServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
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
    assetServer!.listen(0, DESKTOP_HOST, () => {
      assetServer!.off("error", reject);
      resolve();
    });
  });
  const address = assetServer.address() as AddressInfo | null;
  if (!address) throw new Error("Servidor local da interface não informou uma porta.");
  packagedOrigin = `http://${DESKTOP_HOST}:${address.port}`;
  return packagedOrigin;
}

function backendExecutableName(): string {
  return process.platform === "win32" ? "risk-desktop-backend.exe" : "risk-desktop-backend";
}

function backendExecutablePath(): string {
  const override = process.env.RISK_BACKEND_BIN?.trim();
  if (override) return path.resolve(override);
  if (app.isPackaged) return path.join(process.resourcesPath, "backend", backendExecutableName());
  return path.resolve(root, "../../../desktop-backend/target/debug", backendExecutableName());
}

async function startBackend(webOrigin: string): Promise<{ baseUrl: string; token: string }> {
  const executable = backendExecutablePath();
  await access(executable, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK).catch(() => {
    throw new Error(`Backend Rust não encontrado ou não executável em ${executable}`);
  });
  const token = randomBytes(32).toString("base64url");
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      RISK_DATA_DIR: app.getPath("userData"),
      RISK_LOCAL_TOKEN: token,
      RISK_WEB_ORIGIN: webOrigin,
      RISK_BACKEND_BIND: "127.0.0.1:0",
      RUST_LOG: process.env.RUST_LOG ?? "risk_desktop_backend=info,tower_http=warn",
    },
  });
  backendProcess = child;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => console.error(`[risk-backend] ${chunk.trimEnd()}`));

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("O backend local não ficou pronto dentro de 20 segundos."));
    }, 20_000);
    const cleanup = () => clearTimeout(timeout);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Backend local encerrou antes do readiness (code=${code ?? "?"}, signal=${signal ?? "?"}).`));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.startsWith("RISK_BACKEND_READY ")) {
          try {
            const payload = JSON.parse(line.slice("RISK_BACKEND_READY ".length)) as { url?: unknown };
            if (typeof payload.url !== "string" || !payload.url.startsWith("http://127.0.0.1:")) {
              throw new Error("URL de readiness inválida.");
            }
            if (!settled) {
              settled = true;
              cleanup();
              resolve(payload.url);
            }
          } catch (error) {
            if (!settled) {
              settled = true;
              cleanup();
              reject(error);
            }
          }
        } else if (line) {
          console.log(`[risk-backend] ${line}`);
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
  });

  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Healthcheck do backend falhou com HTTP ${response.status}.`);
  return { baseUrl, token };
}

function stopBackend(): void {
  const child = backendProcess;
  backendProcess = undefined;
  backendConfig = undefined;
  if (!child || child.killed) return;
  child.stdin?.end();
  const forceTimer = setTimeout(() => {
    if (!child.killed) child.kill();
  }, 1_500);
  child.once("exit", () => clearTimeout(forceTimer));
}

ipcMain.handle("backend:config", async (event) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  if (!backendConfig) throw new Error("Backend local ainda não está pronto.");
  return backendConfig;
});

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

ipcMain.handle("screen:select", async (event, sourceId: unknown) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 512) {
    throw new Error("Fonte de compartilhamento inválida.");
  }
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  if (!sources.some((source) => source.id === sourceId)) {
    throw new Error("A fonte selecionada não está mais disponível.");
  }
  pendingDisplaySourceId = sourceId;
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

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    if (!app.isPackaged) await clearDevBackendBridge();
    pageUrl = app.isPackaged ? await startPackagedWebServer() : "http://localhost:5173";
    backendConfig = await startBackend(pageUrl);
    await publishDevBackendBridge(backendConfig);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isTrustedRendererUrl(webContents.getURL()) && ["media", "display-capture"].includes(permission));
    });
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const sourceId = pendingDisplaySourceId;
      pendingDisplaySourceId = undefined;
      if (!sourceId || !isTrustedRendererUrl(request.securityOrigin)) {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        const selected = sources.find((source) => source.id === sourceId);
        if (!selected) {
          callback({});
          return;
        }
        callback({
          video: selected,
          audio: request.audioRequested ? "loopback" : undefined,
        });
      } catch (error) {
        console.error("Falha ao autorizar compartilhamento de tela", error);
        callback({});
      }
    });
    createWindow();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  }).catch((error) => {
    console.error("Falha ao iniciar o Risk", error);
    dialog.showErrorBox("Risk não conseguiu iniciar", error instanceof Error ? error.message : String(error));
    void clearDevBackendBridge();
    stopBackend();
    app.quit();
  });
}

app.on("before-quit", () => {
  pendingDisplaySourceId = undefined;
  void clearDevBackendBridge();
  stopBackend();
  assetServer?.close();
  assetServer = undefined;
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
