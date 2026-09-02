import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

export type PrivateNetworkProvider = "zerotier" | "tailscale" | "wireguard" | "vpn" | "unknown";

export type NetworkInterfaceDescriptor = {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  netmask?: string;
  cidr?: string;
  provider: PrivateNetworkProvider;
};

export function detectPrivateNetworkProvider(interfaceName: string): PrivateNetworkProvider {
  const name = interfaceName.trim().toLocaleLowerCase();
  if (name.includes("zerotier") || /^zt[a-z0-9]{4,}/i.test(name)) return "zerotier";
  if (name.includes("tailscale")) return "tailscale";
  if (name.includes("wireguard") || /^wg\d+(?:$|[-_.])/i.test(name)) return "wireguard";
  if (/(?:^|[-_. ])(?:tun|tap|vpn|openvpn|ipsec|ppp)\d*(?:$|[-_. ])/i.test(name)) return "vpn";
  return "unknown";
}

export function collectNetworkInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined>,
): NetworkInterfaceDescriptor[] {
  const result: NetworkInterfaceDescriptor[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!name || !entries) continue;
    for (const entry of entries) {
      if (entry.internal || !entry.address || isIP(entry.address) === 0) continue;
      const family = entry.family === "IPv4"
        ? "IPv4"
        : entry.family === "IPv6"
          ? "IPv6"
          : undefined;
      if (!family) continue;
      result.push({
        name,
        address: entry.address,
        family,
        netmask: entry.netmask || undefined,
        cidr: entry.cidr || undefined,
        provider: detectPrivateNetworkProvider(name),
      });
    }
  }
  return result;
}
