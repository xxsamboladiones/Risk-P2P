import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRtcNetworkContext } from "./runtime";

afterEach(() => vi.unstubAllGlobals());

describe("contexto de rede do RTC", () => {
  it("combina a preferência salva com as interfaces do Electron", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ preference: "private-vpn" }),
    });
    vi.stubGlobal("window", {
      desktop: {
        getNetworkInterfaces: vi.fn(async () => [
          { name: "tailscale0", address: "100.64.0.8", family: "IPv4", provider: "tailscale" },
        ]),
      },
    });

    await expect(loadRtcNetworkContext()).resolves.toEqual({
      preference: "private-vpn",
      networkInterfaces: [
        { name: "tailscale0", address: "100.64.0.8", family: "IPv4", provider: "tailscale" },
      ],
    });
  });

  it("preserva a preferência e faz fallback se o IPC estiver indisponível", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ preference: "internet-direct" }),
    });
    vi.stubGlobal("window", {});

    await expect(loadRtcNetworkContext()).resolves.toEqual({
      preference: "internet-direct",
      networkInterfaces: [],
    });
  });
});
