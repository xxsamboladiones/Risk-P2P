import { app, BrowserWindow, dialog, globalShortcut, type Tray } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopBackendManager } from "./backend.js";
import { configurePlatformRuntime } from "./gpu.js";
import { registerDesktopIpc } from "./ipc/index.js";
import { registerPermissionPolicy } from "./permissions.js";
import {
  PACKAGED_ENTRY_URL,
  PACKAGED_HOST,
  PACKAGED_ORIGIN,
  PACKAGED_SCHEME,
  registerPackagedProtocol,
  registerRiskScheme,
} from "./protocol.js";
import { ScreenCaptureController } from "./screen-capture.js";
import { createApplicationTray, isTrayAvailable } from "./tray.js";
import { createMainWindow } from "./window.js";
import { PerformanceRecorder } from "./performance-recorder.js";
import type { RendererPerformanceSnapshot } from "./ipc/index.js";

configurePlatformRuntime();
registerRiskScheme();

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEVELOPMENT_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const PACKAGED_ORIGIN_REPORT_FILE = process.env.RISK_PACKAGED_ORIGIN_REPORT_FILE?.trim();
const PERFORMANCE_REPORT_FILE = process.env.RISK_PERFORMANCE_REPORT_FILE?.trim();
const PERFORMANCE_SCENARIO = process.env.RISK_PERFORMANCE_SCENARIO?.trim() || "unnamed";
const configuredPerformanceDuration = Number(process.env.RISK_PERFORMANCE_DURATION_MS);
const PERFORMANCE_DURATION_MS = Number.isFinite(configuredPerformanceDuration) && configuredPerformanceDuration > 0
  ? configuredPerformanceDuration
  : 60_000;
const DEV_BACKEND_BRIDGE_FILE = path.resolve(rootDirectory, "../../../.risk/dev-backend.json");
const APP_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.resolve(rootDirectory, "../build/icon.png");

let pageUrl = "http://localhost:5173";
let isQuitting = false;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let activePerformanceRecorder: PerformanceRecorder | undefined;
let pendingRendererSnapshot: {
  sender: Electron.WebContents;
  resolve: (snapshot: RendererPerformanceSnapshot) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
} | undefined;

function requestRendererPerformanceSnapshot(window: BrowserWindow): Promise<RendererPerformanceSnapshot> {
  if (pendingRendererSnapshot) return Promise.reject(new Error("Já existe uma coleta do renderer em andamento."));
  return new Promise<RendererPerformanceSnapshot>((resolve, reject) => {
    const sender = window.webContents;
    const timeout = setTimeout(() => {
      if (pendingRendererSnapshot?.sender !== sender) return;
      pendingRendererSnapshot = undefined;
      reject(new Error("O renderer não respondeu à coleta de desempenho."));
    }, 2_000);
    pendingRendererSnapshot = { sender, resolve, reject, timeout };
    sender.send("performance:request-renderer-snapshot");
  });
}

function acceptRendererPerformanceSnapshot(sender: Electron.WebContents, snapshot: RendererPerformanceSnapshot): void {
  if (pendingRendererSnapshot?.sender !== sender) return;
  clearTimeout(pendingRendererSnapshot.timeout);
  const { resolve } = pendingRendererSnapshot;
  pendingRendererSnapshot = undefined;
  resolve(snapshot);
}

function requestRendererPerformanceCaptureStart(window: BrowserWindow): void {
  window.webContents.send("performance:start-renderer-capture");
}

function startPerformanceCapture(): void {
  if (!PERFORMANCE_REPORT_FILE || activePerformanceRecorder) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const recorder = new PerformanceRecorder({
    reportFile: PERFORMANCE_REPORT_FILE,
    scenario: PERFORMANCE_SCENARIO,
    buildVersion: app.getVersion(),
    durationMs: PERFORMANCE_DURATION_MS,
    now: Date.now,
    getAppMetrics: () => app.getAppMetrics(),
    requestRendererSnapshot: () => requestRendererPerformanceSnapshot(window),
    writeFile: async (file, contents) => writeFile(file, contents, "utf8"),
    onComplete: (report) => {
      console.info("Relatório de desempenho do Risk gravado", { scenario: report.scenario, reportFile: PERFORMANCE_REPORT_FILE });
      if (activePerformanceRecorder === recorder) activePerformanceRecorder = undefined;
    },
    onError: (error) => {
      console.error("Falha ao gravar relatório de desempenho do Risk", error);
      if (activePerformanceRecorder === recorder) activePerformanceRecorder = undefined;
    },
  });
  activePerformanceRecorder = recorder;
  requestRendererPerformanceCaptureStart(window);
  recorder.start();
}

function registerPerformanceMeasurementShortcut(): void {
  if (!PERFORMANCE_REPORT_FILE) return;
  globalShortcut.register("CommandOrControl+Alt+Shift+F11", startPerformanceCapture);
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (app.isPackaged) return parsed.protocol === `${PACKAGED_SCHEME}:` && parsed.host === PACKAGED_HOST;
    return DEVELOPMENT_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

const backend = new DesktopBackendManager(
  rootDirectory,
  DEV_BACKEND_BRIDGE_FILE,
  () => isQuitting,
);
const screenCapture = new ScreenCaptureController(isTrustedRendererUrl);

function openMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const window = createMainWindow({
    pageUrl,
    rootDirectory,
    iconPath: APP_ICON_PATH,
    packagedOriginReportFile: PACKAGED_ORIGIN_REPORT_FILE,
    isQuitting: () => isQuitting,
    trayAvailable: () => isTrayAvailable(tray),
    isTrustedRendererUrl,
    onClosed: (closedWindow) => {
      if (mainWindow === closedWindow) mainWindow = undefined;
    },
  });
  mainWindow = window;
  return window;
}

function showMainWindow(): void {
  const window = openMainWindow();
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function quitApplication(): void {
  isQuitting = true;
  app.quit();
}

function restartApplication(): void {
  isQuitting = true;
  app.relaunch();
  app.quit();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (app.isReady()) showMainWindow();
  });

  app.whenReady().then(async () => {
    // O IPC também registra um atalho global, que exige o Electron pronto.
    registerDesktopIpc(backend, isTrustedRendererUrl, acceptRendererPerformanceSnapshot);
    if (app.isPackaged) {
      await registerPackagedProtocol(path.resolve(process.resourcesPath, "web"));
      pageUrl = PACKAGED_ENTRY_URL;
    } else {
      await backend.clearDevBridge();
      pageUrl = "http://localhost:5173";
    }

    const webOrigin = app.isPackaged ? PACKAGED_ORIGIN : pageUrl;
    await backend.start(webOrigin);
    registerPermissionPolicy(isTrustedRendererUrl);
    screenCapture.register();
    tray = createApplicationTray(APP_ICON_PATH, {
      show: showMainWindow,
      restart: restartApplication,
      quit: quitApplication,
    });
    openMainWindow();
    registerPerformanceMeasurementShortcut();
    app.on("activate", showMainWindow);
  }).catch((error) => {
    console.error("Falha ao iniciar o Risk", error);
    dialog.showErrorBox("Risk não conseguiu iniciar", error instanceof Error ? error.message : String(error));
    void backend.clearDevBridge();
    backend.stop();
    app.quit();
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  tray?.destroy();
  tray = undefined;
  screenCapture.clear();
  globalShortcut.unregister("CommandOrControl+Alt+Shift+F11");
  void backend.clearDevBridge();
  backend.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && (!isTrayAvailable(tray) || Boolean(PACKAGED_ORIGIN_REPORT_FILE))) app.quit();
});
