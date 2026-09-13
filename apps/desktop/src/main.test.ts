import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  ready: false,
  packaged: false,
  ownsInstance: true,
  resolveReady: () => {},
  handlers: new Map<string, unknown>(),
  shortcuts: new Map<string, () => void>(),
  quit: vi.fn(),
  showErrorBox: vi.fn(),
  createWindow: vi.fn(),
}));

// Keep main.ts and registerDesktopIpc real; replace OS services and the sidecar.
vi.mock("electron", () => ({
  app: {
    get isPackaged() { return runtime.packaged; },
    isReady: () => runtime.ready,
    requestSingleInstanceLock: () => runtime.ownsInstance,
    whenReady: () => new Promise<void>((resolve) => {
      runtime.resolveReady = () => { runtime.ready = true; resolve(); };
    }),
    on: vi.fn(),
    quit: runtime.quit,
  },
  BrowserWindow: {},
  dialog: { showErrorBox: runtime.showErrorBox },
  ipcMain: { handle: (name: string, handler: unknown) => runtime.handlers.set(name, handler) },
  globalShortcut: {
    register: (accelerator: string, handler: () => void) => {
      if (!runtime.ready) throw new Error("globalShortcut cannot be used before the app is ready");
      runtime.shortcuts.set(accelerator, handler);
      return true;
    },
  },
  shell: {},
}));
vi.mock("./backend.js", () => ({
  DesktopBackendManager: class {
    async clearDevBridge() {}
    async start() {}
    stop() {}
  },
}));
vi.mock("./gpu.js", () => ({ configurePlatformRuntime() {} }));
vi.mock("./protocol.js", () => ({
  PACKAGED_ENTRY_URL: "risk://app/index.html",
  PACKAGED_HOST: "app",
  PACKAGED_ORIGIN: "risk://app",
  PACKAGED_SCHEME: "risk",
  registerRiskScheme() {},
  async registerPackagedProtocol() {},
}));
vi.mock("./permissions.js", () => ({ registerPermissionPolicy() {} }));
vi.mock("./screen-capture.js", () => ({
  ScreenCaptureController: class { register() {} clear() {} },
}));
vi.mock("./tray.js", () => ({ createApplicationTray() {}, isTrayAvailable: () => false }));
vi.mock("./window.js", () => ({ createMainWindow: runtime.createWindow }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.ready = false;
  runtime.ownsInstance = true;
  runtime.packaged = false;
  runtime.handlers.clear();
  runtime.shortcuts.clear();
  Object.defineProperty(process, "resourcesPath", { value: "/risk-resources", configurable: true });
});

describe("inicialização do desktop", () => {
  it.each([false, true])("aguarda o Electron e instala o IPC antes da janela (empacotado: %s)", async (packaged) => {
    runtime.packaged = packaged;
    runtime.createWindow.mockImplementation(() => {
      expect(runtime.shortcuts.has("CommandOrControl+Alt+Shift+F12")).toBe(true);
      expect(runtime.handlers.has("backend:config")).toBe(true);
      expect(runtime.handlers.has("window:fullscreen")).toBe(true);
      return {};
    });

    await import("./main.js");
    expect(runtime.shortcuts.size).toBe(0);
    expect(runtime.createWindow).not.toHaveBeenCalled();

    runtime.resolveReady();
    await vi.waitFor(() => expect(runtime.createWindow).toHaveBeenCalledOnce());
    expect(runtime.showErrorBox).not.toHaveBeenCalled();
    expect(runtime.quit).not.toHaveBeenCalled();
  });

  it("encerra a segunda instância sem registrar atalhos ou abrir outra janela", async () => {
    runtime.ownsInstance = false;
    await import("./main.js");
    expect(runtime.quit).toHaveBeenCalledOnce();
    expect(runtime.shortcuts.size).toBe(0);
    expect(runtime.handlers.size).toBe(0);
    expect(runtime.createWindow).not.toHaveBeenCalled();
  });
});
