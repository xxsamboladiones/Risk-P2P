import { afterEach, describe, expect, it, vi } from "vitest";

const { appendSwitch } = vi.hoisted(() => ({ appendSwitch: vi.fn() }));
vi.mock("electron", () => ({
  app: {
    commandLine: { appendSwitch },
    disableHardwareAcceleration: vi.fn(),
  },
}));

import { configurePlatformRuntime } from "./gpu.js";

afterEach(() => {
  appendSwitch.mockClear();
  delete process.env.RISK_DISABLE_WGC;
  delete process.env.RISK_FORCE_WGC_SCREEN;
});

describe("captura de tela no Windows", () => {
  it("usa DXGI para monitores e mantém WGC para janelas por padrão", () => {
    configurePlatformRuntime();
    expect(appendSwitch).toHaveBeenCalledWith(
      "disable-features",
      "WebRtcAllowWgcScreenCapturer",
    );
    expect(appendSwitch.mock.calls.some(([, value]) => String(value).includes("WebRtcAllowWgcDesktopCapturer"))).toBe(false);
  });

  it("permite reativar WGC para monitores em máquinas que precisem dele", () => {
    process.env.RISK_FORCE_WGC_SCREEN = "1";
    configurePlatformRuntime();
    expect(appendSwitch.mock.calls.some(([, value]) => String(value).includes("WebRtcAllowWgcScreenCapturer"))).toBe(false);
  });

  it("permite usar o capturador legado explicitamente para compatibilidade", () => {
    process.env.RISK_DISABLE_WGC = "1";
    configurePlatformRuntime();
    expect(appendSwitch).toHaveBeenCalledWith(
      "disable-features",
      expect.stringContaining("WebRtcAllowWgcDesktopCapturer"),
    );
    expect(appendSwitch).toHaveBeenCalledWith(
      "disable-features",
      expect.stringContaining("WebRtcAllowWgcScreenCapturer"),
    );
  });
});
