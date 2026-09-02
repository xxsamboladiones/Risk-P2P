export type PrivateNetworkProvider = "zerotier" | "tailscale" | "wireguard" | "vpn" | "unknown";

export type NetworkInterfaceDescriptor = {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  netmask?: string;
  cidr?: string;
  provider: PrivateNetworkProvider;
};

export type ConnectionPathKind = "vpn-direct" | "lan-direct" | "internet-direct" | "turn-relay" | "unknown";

export type SelectedConnectionPath = {
  kind: ConnectionPathKind;
  label: string;
  provider?: PrivateNetworkProvider;
  protocol?: string;
  localCandidateType?: RTCIceCandidateType;
  remoteCandidateType?: RTCIceCandidateType;
  localPort?: number;
  remotePort?: number;
  relayProtocol?: string;
  networkInterface?: string;
};

export type CandidateStatsLike = {
  id: string;
  type: "local-candidate" | "remote-candidate";
  candidateType?: RTCIceCandidateType;
  address?: string;
  ip?: string;
  port?: number;
  protocol?: string;
  relayProtocol?: string;
};

export type CandidatePairStatsLike = {
  id: string;
  type: "candidate-pair";
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  bytesSent?: number;
  bytesReceived?: number;
  lastPacketReceivedTimestamp?: number;
};

type TransportStatsLike = {
  id: string;
  type: "transport";
  selectedCandidatePairId?: string;
};

type StatsLike = CandidateStatsLike | CandidatePairStatsLike | TransportStatsLike | { id: string; type: string };

export type SelectedCandidatePair = {
  pair: CandidatePairStatsLike;
  localCandidate?: CandidateStatsLike;
  remoteCandidate?: CandidateStatsLike;
};

export type StatsReportLike = {
  forEach(callback: (report: StatsLike) => void): void;
  get(id: string): StatsLike | undefined;
};

function candidateAddress(candidate: CandidateStatsLike | undefined): string | undefined {
  return candidate?.address ?? candidate?.ip;
}

function normalizeIpv6(value: string): string | undefined {
  const zoneIndex = value.indexOf("%");
  const withoutZone = (zoneIndex >= 0 ? value.slice(0, zoneIndex) : value).toLocaleLowerCase();
  const pieces = withoutZone.split("::");
  if (pieces.length > 2) return undefined;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces[1] ? pieces[1].split(":") : [];
  if (pieces.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16).toString(16)).join(":");
}

export function normalizeIpAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let normalized = value.trim();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedIpv4) normalized = mappedIpv4;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const octets = normalized.split(".").map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255) ? octets.join(".") : undefined;
  }
  return normalizeIpv6(normalized);
}

export function isSameAddress(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeIpAddress(left);
  return normalizedLeft !== undefined && normalizedLeft === normalizeIpAddress(right);
}

function pairFallbackScore(pair: CandidatePairStatsLike): number {
  const selection = pair.selected ? 2 : pair.nominated ? 1 : 0;
  const recentTraffic = pair.lastPacketReceivedTimestamp ?? 0;
  const traffic = (pair.bytesSent ?? 0) + (pair.bytesReceived ?? 0);
  return selection * 1e15 + recentTraffic * 1e3 + Math.min(traffic, 1e9);
}

export function resolveSelectedCandidatePair(report: StatsReportLike): SelectedCandidatePair | undefined {
  const transports: TransportStatsLike[] = [];
  const pairs: CandidatePairStatsLike[] = [];
  report.forEach((stat) => {
    if (stat.type === "transport") transports.push(stat as TransportStatsLike);
    else if (stat.type === "candidate-pair") pairs.push(stat as CandidatePairStatsLike);
  });

  const selectedPairId = transports.find((transport) => transport.selectedCandidatePairId)?.selectedCandidatePairId;
  const selectedByTransport = selectedPairId ? report.get(selectedPairId) : undefined;
  const pair = selectedByTransport?.type === "candidate-pair"
    ? selectedByTransport as CandidatePairStatsLike
    : pairs
      .filter((candidatePair) => candidatePair.state === "succeeded")
      .sort((left, right) => pairFallbackScore(right) - pairFallbackScore(left))[0];
  if (!pair) return undefined;

  const local = pair.localCandidateId ? report.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId ? report.get(pair.remoteCandidateId) : undefined;
  return {
    pair,
    localCandidate: local?.type === "local-candidate" ? local as CandidateStatsLike : undefined,
    remoteCandidate: remote?.type === "remote-candidate" ? remote as CandidateStatsLike : undefined,
  };
}

function providerLabel(provider: PrivateNetworkProvider | undefined): string {
  if (provider === "zerotier") return "ZeroTier";
  if (provider === "tailscale") return "Tailscale";
  if (provider === "wireguard") return "WireGuard";
  return "";
}

export function connectionPathLabel(kind: ConnectionPathKind, provider?: PrivateNetworkProvider): string {
  if (kind === "vpn-direct") {
    const providerName = providerLabel(provider);
    return providerName ? `VPN direta (${providerName})` : "VPN direta";
  }
  if (kind === "lan-direct") return "LAN direta";
  if (kind === "internet-direct") return "P2P direto";
  if (kind === "turn-relay") return "TURN Relay";
  return "Rota desconhecida";
}

export function classifySelectedConnectionPath(
  selected: SelectedCandidatePair | undefined,
  interfaces: readonly NetworkInterfaceDescriptor[] = [],
): SelectedConnectionPath {
  const local = selected?.localCandidate;
  const remote = selected?.remoteCandidate;
  const localType = local?.candidateType;
  const remoteType = remote?.candidateType;
  const protocol = local?.protocol ?? remote?.protocol;
  const base = {
    protocol,
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    localPort: local?.port,
    remotePort: remote?.port,
  };

  if (localType === "relay" || remoteType === "relay") {
    return {
      ...base,
      kind: "turn-relay",
      label: connectionPathLabel("turn-relay"),
      relayProtocol: local?.relayProtocol ?? remote?.relayProtocol,
    };
  }

  if (localType === "host") {
    const networkInterface = interfaces.find((item) => isSameAddress(item.address, candidateAddress(local)));
    if (networkInterface?.provider && networkInterface.provider !== "unknown") {
      return {
        ...base,
        kind: "vpn-direct",
        label: connectionPathLabel("vpn-direct", networkInterface.provider),
        provider: networkInterface.provider,
        networkInterface: networkInterface.name,
      };
    }
    if (networkInterface && remoteType === "host") {
      return {
        ...base,
        kind: "lan-direct",
        label: connectionPathLabel("lan-direct"),
        networkInterface: networkInterface.name,
      };
    }
  }

  if (localType === "srflx" || localType === "prflx" || remoteType === "srflx" || remoteType === "prflx") {
    return { ...base, kind: "internet-direct", label: connectionPathLabel("internet-direct") };
  }

  return { ...base, kind: "unknown", label: connectionPathLabel("unknown") };
}
