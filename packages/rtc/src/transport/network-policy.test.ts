import { describe, expect, it } from "vitest";
import type { NetworkInterfaceDescriptor } from "../connection-path";
import { candidateUsesVpn, prepareLocalIceCandidate, prepareLocalSessionDescription, vpnInterfaces } from "./network-policy";

const interfaces: NetworkInterfaceDescriptor[] = [
  { name: "ztabcdef", address: "10.147.20.5", family: "IPv4", provider: "zerotier" },
  { name: "eth0", address: "192.168.1.5", family: "IPv4", provider: "unknown" },
];
const vpnCandidate = { candidate: "candidate:1 1 udp 2122260223 10.147.20.5 50000 typ host generation 0" };
const internetCandidate = { candidate: "candidate:2 1 udp 1686052607 203.0.113.4 40000 typ srflx raddr 192.168.1.5 rport 50001" };

describe("política de rede do RTC", () => {
  it("mantém todos os candidates no modo automático", () => {
    expect(prepareLocalIceCandidate(vpnCandidate, "auto", interfaces)).toBe(vpnCandidate);
    expect(prepareLocalIceCandidate(internetCandidate, "auto", interfaces)).toBe(internetCandidate);
  });

  it("remove somente o candidate do adaptador VPN no modo internet direta", () => {
    expect(prepareLocalIceCandidate(vpnCandidate, "internet-direct", interfaces)).toBeNull();
    expect(prepareLocalIceCandidate(internetCandidate, "internet-direct", interfaces)).toBe(internetCandidate);
  });

  it("eleva a prioridade da VPN sem remover o fallback STUN", () => {
    expect(prepareLocalIceCandidate(vpnCandidate, "private-vpn", interfaces)?.candidate)
      .toContain("udp 2130706431 10.147.20.5");
    expect(prepareLocalIceCandidate(internetCandidate, "private-vpn", interfaces)).toBe(internetCandidate);
  });

  it("resume somente interfaces privadas reconhecidas", () => {
    expect(candidateUsesVpn(vpnCandidate, interfaces)).toBe(true);
    expect(vpnInterfaces(interfaces)).toEqual([
      { name: "ztabcdef", address: "10.147.20.5", family: "IPv4", provider: "zerotier" },
    ]);
  });

  it("aplica a política também aos candidates que já vieram no SDP", () => {
    const description = {
      type: "offer" as const,
      sdp: `v=0\r\na=${vpnCandidate.candidate}\r\na=${internetCandidate.candidate}\r\n`,
    };
    const direct = prepareLocalSessionDescription(description, "internet-direct", interfaces).sdp!;
    expect(direct).not.toContain("10.147.20.5");
    expect(direct).toContain("203.0.113.4");

    const preferred = prepareLocalSessionDescription(description, "private-vpn", interfaces).sdp!;
    expect(preferred).toContain("udp 2130706431 10.147.20.5");
    expect(preferred).toContain("203.0.113.4");
  });
});
