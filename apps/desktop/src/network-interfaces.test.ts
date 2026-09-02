import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { collectNetworkInterfaces, detectPrivateNetworkProvider } from "./network-interfaces.js";

function entry(address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false): NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
    mac: "00:00:00:00:00:00",
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

describe("detectPrivateNetworkProvider", () => {
  it("reconhece nomes ZeroTier do Linux e Windows", () => {
    expect(detectPrivateNetworkProvider("ztabcd1234")).toBe("zerotier");
    expect(detectPrivateNetworkProvider("ZeroTier One [abcdef1234]")).toBe("zerotier");
  });

  it("mantém a abstração para outros overlays", () => {
    expect(detectPrivateNetworkProvider("tailscale0")).toBe("tailscale");
    expect(detectPrivateNetworkProvider("WireGuard Tunnel")).toBe("wireguard");
    expect(detectPrivateNetworkProvider("tun0")).toBe("vpn");
    expect(detectPrivateNetworkProvider("Ethernet")).toBe("unknown");
  });
});

describe("collectNetworkInterfaces", () => {
  it("sanitiza entradas e ignora loopback e endereços inválidos", () => {
    expect(collectNetworkInterfaces({
      ztabcd1234: [entry("10.147.20.5")],
      Ethernet: [entry("192.168.1.55")],
      Loopback: [entry("127.0.0.1", "IPv4", true)],
      Broken: [entry("not-an-ip")],
    })).toEqual([
      expect.objectContaining({ name: "ztabcd1234", address: "10.147.20.5", provider: "zerotier" }),
      expect.objectContaining({ name: "Ethernet", address: "192.168.1.55", provider: "unknown" }),
    ]);
  });
});
