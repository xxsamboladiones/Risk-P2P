import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NETWORK_SETTINGS,
  loadNetworkSettings,
  networkPreferenceLabel,
  saveNetworkSettings,
} from "./settings";

describe("configurações de rede", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  });

  it("usa automático quando não há preferência válida", () => {
    expect(loadNetworkSettings()).toEqual(DEFAULT_NETWORK_SETTINGS);
    localStorage.setItem("risk.network-settings.v1", JSON.stringify({ preference: "insegura" }));
    expect(loadNetworkSettings()).toEqual(DEFAULT_NETWORK_SETTINGS);
  });

  it("persiste a preferência escolhida", () => {
    saveNetworkSettings({ preference: "private-vpn" });
    expect(loadNetworkSettings()).toEqual({ preference: "private-vpn" });
    expect(networkPreferenceLabel("private-vpn")).toBe("VPN privada quando disponível");
  });
});
