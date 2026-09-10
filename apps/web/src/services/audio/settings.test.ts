import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVoiceVideoSettings } from "./settings";

function storage(value?: string) {
  return { getItem: vi.fn(() => value ?? null), setItem: vi.fn(), removeItem: vi.fn() };
}

afterEach(() => vi.unstubAllGlobals());

describe("voice/video settings", () => {
  it("ativa o ganho automático por padrão no Windows", () => {
    vi.stubGlobal("localStorage", storage());
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect(loadVoiceVideoSettings().automaticGainControl).toBe(true);
  });

  it("mantém o ganho automático desligado por padrão no Linux", () => {
    vi.stubGlobal("localStorage", storage());
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    expect(loadVoiceVideoSettings().automaticGainControl).toBe(false);
  });

  it("preserva uma escolha explícita mesmo quando a plataforma recomenda outra", () => {
    vi.stubGlobal("localStorage", storage(JSON.stringify({ automaticGainControl: false })));
    vi.stubGlobal("navigator", { userAgent: "Windows" });
    expect(loadVoiceVideoSettings().automaticGainControl).toBe(false);
  });
});
