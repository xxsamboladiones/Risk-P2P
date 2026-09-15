import { beforeEach, describe, expect, it, vi } from "vitest";

const electronRuntime = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: { getURL(): string } }, value: unknown) => Promise<unknown>>(),
  owner: null as null | { webContents: { setBackgroundThrottling(value: boolean): void } },
  fromWebContents: vi.fn(),
  setBackgroundThrottling: vi.fn(),
  windowOptions: null as null | { webPreferences?: { backgroundThrottling?: boolean } },
}));

vi.mock("electron", () => {
  const BrowserWindow = vi.fn((options: { webPreferences?: { backgroundThrottling?: boolean } }) => {
    electronRuntime.windowOptions = options;
    return {
      hide: vi.fn(),
      isDestroyed: () => false,
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      once: vi.fn(),
      show: vi.fn(),
      webContents: {
        on: vi.fn(),
        once: vi.fn(),
        setWebRTCIPHandlingPolicy: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
    };
  });
  Object.assign(BrowserWindow, {
    fromWebContents: electronRuntime.fromWebContents,
    getAllWindows: () => [],
  });
  return {
    app: { isPackaged: false },
    BrowserWindow,
    globalShortcut: { register: vi.fn() },
    ipcMain: {
      handle: (
        name: string,
        handler: (event: { sender: { getURL(): string } }, value: unknown) => Promise<unknown>,
      ) => electronRuntime.handlers.set(name, handler),
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: { openExternal: vi.fn() },
  };
});

import { registerDesktopIpc } from "./ipc/index.js";
import { parseDesktopPerformancePolicy } from "./performance-policy.js";
import { createMainWindow } from "./window.js";

it("accepts only the Electron-facing boolean permission", () => {
  expect(parseDesktopPerformancePolicy({ chromiumBackgroundThrottlingAllowed: true })).toEqual({
    chromiumBackgroundThrottlingAllowed: true,
  });
  expect(() => parseDesktopPerformancePolicy({
    chromiumBackgroundThrottlingAllowed: "yes",
  })).toThrow("Política de desempenho inválida");
  expect(() => parseDesktopPerformancePolicy({
    chromiumBackgroundThrottlingAllowed: true,
    command: "quit",
  })).toThrow("Política de desempenho inválida");
});

describe("performance:set-policy", () => {
  beforeEach(() => {
    electronRuntime.handlers.clear();
    electronRuntime.fromWebContents.mockReset();
    electronRuntime.setBackgroundThrottling.mockReset();
    electronRuntime.owner = {
      webContents: { setBackgroundThrottling: electronRuntime.setBackgroundThrottling },
    };
    electronRuntime.fromWebContents.mockImplementation(() => electronRuntime.owner);
  });

  function register(): (event: { sender: { getURL(): string } }, value: unknown) => Promise<unknown> {
    registerDesktopIpc(
      { getConfig: () => null } as never,
      (url) => url === "risk://app",
    );
    const handler = electronRuntime.handlers.get("performance:set-policy");
    expect(handler).toBeDefined();
    return handler!;
  }

  it("rejects untrusted renderers before resolving their owner window", async () => {
    const handler = register();

    await expect(handler(
      { sender: { getURL: () => "https://attacker.invalid" } },
      { chromiumBackgroundThrottlingAllowed: false },
    )).rejects.toThrow("Origem do renderer não autorizada");
    expect(electronRuntime.fromWebContents).not.toHaveBeenCalled();
  });

  it("rejects invalid renderer payloads without changing Chromium throttling", async () => {
    const handler = register();

    await expect(handler(
      { sender: { getURL: () => "risk://app" } },
      { chromiumBackgroundThrottlingAllowed: false, command: "quit" },
    )).rejects.toThrow("Política de desempenho inválida");
    expect(electronRuntime.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it("applies the validated permission to the sender's owning BrowserWindow", async () => {
    const handler = register();
    const sender = { getURL: () => "risk://app" };

    await handler({ sender }, { chromiumBackgroundThrottlingAllowed: false });

    expect(electronRuntime.fromWebContents).toHaveBeenCalledWith(sender);
    expect(electronRuntime.setBackgroundThrottling).toHaveBeenCalledOnce();
    expect(electronRuntime.setBackgroundThrottling).toHaveBeenCalledWith(false);
  });

  it("fails closed when the sender has no owning BrowserWindow", async () => {
    electronRuntime.owner = null;
    const handler = register();

    await expect(handler(
      { sender: { getURL: () => "risk://app" } },
      { chromiumBackgroundThrottlingAllowed: true },
    )).rejects.toThrow("Janela do Risk não encontrada");
  });
});

it("starts BrowserWindows with Chromium background throttling allowed", () => {
  electronRuntime.windowOptions = null;

  createMainWindow({
    pageUrl: "risk://app/index.html",
    rootDirectory: "C:\\risk",
    iconPath: "C:\\risk\\icon.png",
    isQuitting: () => false,
    trayAvailable: () => true,
    isTrustedRendererUrl: (url) => url.startsWith("risk://app"),
    onClosed: vi.fn(),
  });

  expect(electronRuntime.windowOptions).toMatchObject({
    webPreferences: { backgroundThrottling: true },
  });
});
