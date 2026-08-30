import { describe, expect, it } from "vitest";
import {
  classifySelectedConnectionPath,
  isSameAddress,
  resolveSelectedCandidatePair,
  type CandidatePairStatsLike,
  type CandidateStatsLike,
  type NetworkInterfaceDescriptor,
  type StatsReportLike,
} from "./connection-path";

function selected(
  local: Partial<CandidateStatsLike>,
  remote: Partial<CandidateStatsLike> = { candidateType: "host" },
) {
  return {
    pair: { id: "pair", type: "candidate-pair" as const, state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote" },
    localCandidate: { id: "local", type: "local-candidate" as const, ...local },
    remoteCandidate: { id: "remote", type: "remote-candidate" as const, ...remote },
  };
}

function networkInterface(overrides: Partial<NetworkInterfaceDescriptor> = {}): NetworkInterfaceDescriptor {
  return {
    name: "Ethernet",
    address: "192.168.1.55",
    family: "IPv4",
    provider: "unknown",
    ...overrides,
  };
}

function statsReport(stats: Array<CandidateStatsLike | CandidatePairStatsLike | { id: string; type: string; selectedCandidatePairId?: string }>): StatsReportLike {
  const map = new Map(stats.map((stat) => [stat.id, stat]));
  return map as unknown as StatsReportLike;
}

describe("classifySelectedConnectionPath", () => {
  it("classifica host na interface ZeroTier como VPN direta", () => {
    const path = classifySelectedConnectionPath(
      selected({ candidateType: "host", address: "10.147.20.5", protocol: "udp" }),
      [networkInterface({ name: "ztabcd1234", address: "10.147.20.5", provider: "zerotier" })],
    );
    expect(path).toMatchObject({ kind: "vpn-direct", provider: "zerotier", label: "VPN direta (ZeroTier)", protocol: "udp" });
  });

  it("classifica host da Ethernet como LAN direta", () => {
    const path = classifySelectedConnectionPath(
      selected({ candidateType: "host", address: "192.168.1.55" }),
      [networkInterface()],
    );
    expect(path).toMatchObject({ kind: "lan-direct", label: "LAN direta" });
  });

  it("classifica srflx e prflx como P2P pela Internet", () => {
    expect(classifySelectedConnectionPath(selected({ candidateType: "srflx" })).kind).toBe("internet-direct");
    expect(classifySelectedConnectionPath(selected({ candidateType: "host" }, { candidateType: "prflx" })).kind).toBe("internet-direct");
  });

  it("prioriza TURN quando qualquer candidate é relay", () => {
    const path = classifySelectedConnectionPath(selected({ candidateType: "host" }, { candidateType: "relay", relayProtocol: "udp" }));
    expect(path).toMatchObject({ kind: "turn-relay", label: "TURN Relay", relayProtocol: "udp" });
  });

  it("permanece unknown com stats incompletos", () => {
    expect(() => classifySelectedConnectionPath(undefined)).not.toThrow();
    expect(classifySelectedConnectionPath(undefined).kind).toBe("unknown");
  });

  it("normaliza IPv6 expandido, comprimido, zone id e IPv4 mapeado", () => {
    expect(isSameAddress("2001:0db8:0:0:0:0:0:1", "[2001:db8::1]")).toBe(true);
    expect(isSameAddress("fe80::abcd%zt0", "fe80:0:0:0:0:0:0:abcd")).toBe(true);
    expect(isSameAddress("::ffff:192.168.1.55", "192.168.1.55")).toBe(true);
  });
});

describe("resolveSelectedCandidatePair", () => {
  const local: CandidateStatsLike = { id: "local", type: "local-candidate", candidateType: "host" };
  const remote: CandidateStatsLike = { id: "remote", type: "remote-candidate", candidateType: "host" };

  it("usa transport.selectedCandidatePairId primeiro", () => {
    const selectedPair: CandidatePairStatsLike = { id: "current", type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote" };
    const oldPair: CandidatePairStatsLike = { id: "old", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "remote" };
    const result = resolveSelectedCandidatePair(statsReport([
      { id: "transport", type: "transport", selectedCandidatePairId: "current" }, oldPair, selectedPair, local, remote,
    ]));
    expect(result?.pair.id).toBe("current");
  });

  it("faz fallback para o succeeded nominated com tráfego mais recente", () => {
    const result = resolveSelectedCandidatePair(statsReport([
      { id: "old", type: "candidate-pair", state: "succeeded", nominated: true, lastPacketReceivedTimestamp: 10 },
      { id: "current", type: "candidate-pair", state: "succeeded", nominated: true, lastPacketReceivedTimestamp: 20, localCandidateId: "local", remoteCandidateId: "remote" },
      local,
      remote,
    ]));
    expect(result?.pair.id).toBe("current");
    expect(result?.localCandidate).toBe(local);
  });
});
