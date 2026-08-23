import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, net, protocol, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "linux") {
  // pipewire-pulse pode expor o PID do daemon em vez do PID do cliente. Marcar
  // o cliente Pulse permite que o mixer Linux identifique o Risk mesmo nesse caminho.
  process.env["PULSE_PROP_application.name"] = "Risk";
  process.env["PULSE_PROP_application.id"] = "com.risk.calls";
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const root = path.dirname(fileURLToPath(import.meta.url));
const DEVELOPMENT_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const PACKAGED_SCHEME = "risk";
const PACKAGED_HOST = "app";
const PACKAGED_ORIGIN = `${PACKAGED_SCHEME}://${PACKAGED_HOST}`;
const PACKAGED_ENTRY_URL = `${PACKAGED_ORIGIN}/index.html`;
const DEV_BACKEND_BRIDGE_FILE = path.resolve(root, "../../../.risk/dev-backend.json");
const WINDOWS_LOOPBACK_WITHOUT_RISK = "loopbackWithoutChrome";
const APP_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.resolve(root, "../build/icon.png");

// A versão empacotada precisa de uma origem estável. O servidor HTTP anterior usava
// uma porta aleatória em cada inicialização, criando uma origem nova e, portanto,
// outro IndexedDB/localStorage. A identidade ECDSA do P2P acabava podendo mudar.
// Um esquema standard mantém Web Storage/IndexedDB habilitados; secure preserva o
// contexto seguro necessário às APIs de mídia do Chromium.
protocol.registerSchemesAsPrivileged([
  {
    scheme: PACKAGED_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

type CapturableSource = Awaited<ReturnType<typeof desktopCapturer.getSources>>[number];
type PendingDisplaySelection = {
  id: string;
  name?: string;
  displayId?: string;
  source?: CapturableSource;
};

let pageUrl = "http://localhost:5173";
let pendingDisplaySelection: PendingDisplaySelection | undefined;
const knownDisplaySources = new Map<string, PendingDisplaySelection>();
let backendProcess: ChildProcess | undefined;
let backendConfig: { baseUrl: string; token: string } | undefined;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function isTrustedRendererUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (app.isPackaged) return parsed.protocol === `${PACKAGED_SCHEME}:` && parsed.host === PACKAGED_HOST;
    return DEVELOPMENT_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

async function registerPackagedProtocol(): Promise<void> {
  const webRoot = path.resolve(process.resourcesPath, "web");
  await protocol.handle(PACKAGED_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.host !== PACKAGED_HOST) return new Response("Not found", { status: 404 });

      const decodedPath = decodeURIComponent(requestUrl.pathname);
      const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
      const filePath = path.resolve(webRoot, relativePath);
      const relative = path.relative(webRoot, filePath);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return new Response("Forbidden", { status: 403 });
      }

      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      console.warn("Falha ao servir recurso do bundle Risk", { url: request.url, error });
      return new Response("Not found", { status: 404 });
    }
  });
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

async function resolveCurrentDisplaySource(selection: PendingDisplaySelection): Promise<CapturableSource | undefined> {
  // No PipeWire/Wayland, desktopCapturer.getSources() abre/usa o portal de captura
  // e o source retornado pertence àquela sessão. Reconsultar o portal durante
  // getDisplayMedia pode invalidar a seleção e resultar em "Invalid capture constraints".
  if (selection.source) return selection.source;
  if (process.platform === "linux") return undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const selected = sources.find((source) => source.id === selection.id)
      ?? (selection.displayId
        ? sources.find((source) => source.display_id === selection.displayId)
        : undefined);
    if (selected) return selected;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return undefined;
}

ipcMain.handle("backend:config", async (event) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  if (!backendConfig) throw new Error("Backend local ainda não está pronto.");
  return backendConfig;
});

ipcMain.handle("window:fullscreen", async (event, enabled: unknown) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  if (typeof enabled !== "boolean") throw new Error("Estado de tela cheia inválido.");
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error("Janela do Risk não encontrada.");
  owner.setFullScreen(enabled);
  if (enabled) owner.focus();
  return { fullscreen: enabled };
});

ipcMain.handle("screen:list", async (event) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  knownDisplaySources.clear();
  sources.forEach((source) => {
    knownDisplaySources.set(source.id, {
      id: source.id,
      name: source.name,
      displayId: source.display_id,
      source,
    });
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    thumbnail: source.thumbnail.toDataURL(),
  }));
});

ipcMain.handle("screen:choose", async (event) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  const allSources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  if (!allSources.length) return null;

  // Em PipeWire o portal do sistema já realizou a escolha e o Electron retorna
  // apenas aquela fonte. Não mostramos uma segunda caixa de seleção redundante.
  if (process.platform === "linux" && allSources.length === 1) {
    const selected = allSources[0]!;
    knownDisplaySources.set(selected.id, {
      id: selected.id,
      name: selected.name,
      displayId: selected.display_id,
      source: selected,
    });
    return selected.id;
  }

  const sources = allSources.slice(0, 20);
  const buttons = [...sources.map((source) => source.name.slice(0, 80)), "Cancelar"];
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    type: "question" as const,
    title: "Compartilhar tela",
    message: "Escolha uma tela ou janela para compartilhar",
    detail: allSources.length > sources.length
      ? `Mostrando as primeiras ${sources.length} fontes disponíveis.`
      : "O áudio do sistema será incluído quando o sistema operacional permitir.",
    buttons,
    defaultId: 0,
    cancelId: sources.length,
    noLink: true,
  };
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if (result.response < 0 || result.response >= sources.length) return null;
  const selected = sources[result.response];
  if (!selected) return null;
  knownDisplaySources.set(selected.id, {
    id: selected.id,
    name: selected.name,
    displayId: selected.display_id,
    source: selected,
  });
  return selected.id;
});

ipcMain.handle("screen:select", async (event, sourceId: unknown) => {
  if (!isTrustedRendererUrl(event.sender.getURL())) throw new Error("Origem do renderer não autorizada.");
  if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 512) {
    throw new Error("Fonte de compartilhamento inválida.");
  }
  const known = knownDisplaySources.get(sourceId);
  if (process.platform === "linux" && !known?.source) {
    throw new Error("A fonte PipeWire selecionada não está mais disponível. Abra o seletor novamente.");
  }
  pendingDisplaySelection = known ?? { id: sourceId };
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#090b10",
    icon: APP_ICON_PATH,
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
    if (app.isPackaged) {
      await registerPackagedProtocol();
      pageUrl = PACKAGED_ENTRY_URL;
    } else {
      await clearDevBackendBridge();
      pageUrl = "http://localhost:5173";
    }
    const webOrigin = app.isPackaged ? PACKAGED_ORIGIN : pageUrl;
    backendConfig = await startBackend(webOrigin);
    await publishDevBackendBridge(backendConfig);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isTrustedRendererUrl(webContents.getURL()) && ["media", "display-capture", "fullscreen"].includes(permission));
    });
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const selection = pendingDisplaySelection;
      pendingDisplaySelection = undefined;
      if (!selection || !isTrustedRendererUrl(request.securityOrigin)) {
        callback({});
        return;
      }
      try {
        const selected = await resolveCurrentDisplaySource(selection);
        if (!selected) {
          console.warn("Fonte de compartilhamento desapareceu antes do getDisplayMedia", {
            id: selection.id,
            name: selection.name,
            displayId: selection.displayId,
          });
          callback({});
          return;
        }

        const audioDevice = process.platform === "win32"
          ? WINDOWS_LOOPBACK_WITHOUT_RISK
          : "loopback";
        if (request.audioRequested) {
          console.info(
            `[risk-screen-audio] Electron ${process.versions.electron}; device=${audioDevice}; source=${selected.name}`,
          );
        }
        callback({
          video: selected,
          ...(request.audioRequested
            ? { audio: audioDevice as unknown as "loopback" }
            : {}),
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
  pendingDisplaySelection = undefined;
  knownDisplaySources.clear();
  void clearDevBackendBridge();
  stopBackend();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});