import { BrowserWindow, globalShortcut, ipcMain, shell, type WebContents } from "electron";
import { networkInterfaces } from "node:os";
import type { DesktopBackendManager } from "../backend.js";
import { collectNetworkInterfaces } from "../network-interfaces.js";
import { parseDesktopPerformancePolicy } from "../performance-policy.js";

export type RendererPerformanceSnapshot = {
  longTaskCount: number;
  longTaskDurationMs: number;
  heapUsedBytes?: number;
};

function readRendererPerformanceSnapshot(value: unknown): RendererPerformanceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  const validNumber = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
  if (!validNumber(snapshot.longTaskCount) || !validNumber(snapshot.longTaskDurationMs)) return null;
  if (snapshot.heapUsedBytes !== undefined && !validNumber(snapshot.heapUsedBytes)) return null;
  return {
    longTaskCount: snapshot.longTaskCount,
    longTaskDurationMs: snapshot.longTaskDurationMs,
    ...(snapshot.heapUsedBytes === undefined ? {} : { heapUsedBytes: snapshot.heapUsedBytes }),
  };
}

export function registerDesktopIpc(
  backend: DesktopBackendManager,
  isTrustedRendererUrl: (value: string) => boolean,
  onRendererPerformanceSnapshot?: (sender: WebContents, snapshot: RendererPerformanceSnapshot) => void,
): void {
  globalShortcut.register("CommandOrControl+Alt+Shift+F12", () => {
    const config = backend.getConfig();
    if (config) void fetch(`${config.baseUrl}/game/emergency-stop`, {
      method: "POST", headers: { "x-risk-desktop-token": config.token }, signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("game:stopped"));
  });
  const assertTrusted = (url: string) => {
    if (!isTrustedRendererUrl(url)) throw new Error("Origem do renderer não autorizada.");
  };

  ipcMain.handle("backend:config", async (event) => {
    assertTrusted(event.sender.getURL());
    const config = backend.getConfig();
    if (!config) throw new Error("Backend local ainda não está pronto.");
    return config;
  });

  ipcMain.handle("network:interfaces", async (event) => {
    assertTrusted(event.sender.getURL());
    return collectNetworkInterfaces(networkInterfaces());
  });

  ipcMain.handle("window:fullscreen", async (event, enabled: unknown) => {
    assertTrusted(event.sender.getURL());
    if (typeof enabled !== "boolean") throw new Error("Estado de tela cheia inválido.");
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error("Janela do Risk não encontrada.");
    owner.setFullScreen(enabled);
    if (enabled) owner.focus();
    return { fullscreen: enabled };
  });

  ipcMain.handle("window:visibility", async (event) => {
    assertTrusted(event.sender.getURL());
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error("Janela do Risk não encontrada.");
    return owner.isVisible() && !owner.isMinimized();
  });

  ipcMain.handle("shell:open-external", async (event, value: unknown) => {
    assertTrusted(event.sender.getURL());
    if (typeof value !== "string" || value.length > 2_048) throw new Error("Link externo inválido.");
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Protocolo de link não permitido.");
    await shell.openExternal(url.toString());
  });

  ipcMain.handle("performance:renderer-snapshot", async (event, value: unknown) => {
    assertTrusted(event.sender.getURL());
    const snapshot = readRendererPerformanceSnapshot(value);
    if (!snapshot) throw new Error("Métrica de desempenho do renderer inválida.");
    onRendererPerformanceSnapshot?.(event.sender, snapshot);
  });

  ipcMain.handle("performance:set-policy", async (event, value: unknown) => {
    assertTrusted(event.sender.getURL());
    const policy = parseDesktopPerformancePolicy(value);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error("Janela do Risk não encontrada.");
    owner.webContents.setBackgroundThrottling(policy.chromiumBackgroundThrottlingAllowed);
  });
}
