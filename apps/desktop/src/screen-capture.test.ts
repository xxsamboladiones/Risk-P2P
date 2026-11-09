import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getSources: vi.fn(),
  setDisplayMediaRequestHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  desktopCapturer: { getSources: runtime.getSources },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => runtime.handlers.set(name, handler) },
  session: { defaultSession: { setDisplayMediaRequestHandler: runtime.setDisplayMediaRequestHandler } },
}));

import { ScreenCaptureController } from "./screen-capture.js";

beforeEach(() => {
  runtime.handlers.clear();
  runtime.getSources.mockReset();
  runtime.setDisplayMediaRequestHandler.mockReset();
});

describe("fontes de captura do desktop", () => {
  it("informa se cada fonte é um monitor ou uma janela", async () => {
    runtime.getSources.mockResolvedValue([
      { id: "screen:0:0", name: "Tela 1", display_id: "1", thumbnail: { toDataURL: () => "screen-preview" } },
      { id: "window:42:0", name: "PCSX2", display_id: "", thumbnail: { toDataURL: () => "window-preview" } },
    ]);
    new ScreenCaptureController((url) => url === "risk://app").register();

    const list = runtime.handlers.get("screen:list");
    expect(list).toBeDefined();
    const result = await list!({ sender: { getURL: () => "risk://app" } });

    expect(result).toEqual([
      expect.objectContaining({ id: "screen:0:0", kind: "screen" }),
      expect.objectContaining({ id: "window:42:0", kind: "window" }),
    ]);
  });
});
