import { isSameAddress, type NetworkInterfaceDescriptor, type PrivateNetworkProvider } from "../connection-path";

export type RtcNetworkPreference = "auto" | "internet-direct" | "private-vpn";

export type MeshTransportOptions = {
  maxRemotePeers?: number;
  networkInterfaces?: readonly NetworkInterfaceDescriptor[];
  networkPreference?: RtcNetworkPreference;
};

export type VpnInterfaceSummary = {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  provider: Exclude<PrivateNetworkProvider, "unknown">;
};

const MAX_HOST_CANDIDATE_PRIORITY = 2_130_706_431;

export function vpnInterfaces(
  interfaces: readonly NetworkInterfaceDescriptor[],
): VpnInterfaceSummary[] {
  return interfaces
    .filter((item): item is NetworkInterfaceDescriptor & { provider: Exclude<PrivateNetworkProvider, "unknown"> } => item.provider !== "unknown")
    .map(({ name, address, family, provider }) => ({ name, address, family, provider }));
}

/**
 * Ajusta somente o candidate enviado ao peer. O Chromium continua reunindo
 * todas as rotas localmente e STUN/TURN permanecem disponíveis como fallback.
 */
export function prepareLocalIceCandidate<Candidate extends RTCIceCandidateInit>(
  candidate: Candidate,
  preference: RtcNetworkPreference,
  interfaces: readonly NetworkInterfaceDescriptor[],
): Candidate | null {
  if (preference === "auto" || !candidate.candidate) return candidate;
  const parsed = parseCandidate(candidate.candidate);
  if (!parsed || parsed.type !== "host") return candidate;
  const isVpn = interfaces.some((item) => item.provider !== "unknown" && isSameAddress(item.address, parsed.address));

  if (preference === "internet-direct") return isVpn ? null : candidate;
  if (!isVpn) return candidate;

  const fields = [...parsed.fields];
  fields[3] = String(MAX_HOST_CANDIDATE_PRIORITY);
  return { ...candidate, candidate: fields.join(" ") } as Candidate;
}

export function candidateUsesVpn(
  candidate: RTCIceCandidateInit,
  interfaces: readonly NetworkInterfaceDescriptor[],
): boolean {
  const parsed = candidate.candidate ? parseCandidate(candidate.candidate) : undefined;
  return Boolean(parsed?.type === "host" && interfaces.some(
    (item) => item.provider !== "unknown" && isSameAddress(item.address, parsed.address),
  ));
}

export function prepareLocalSessionDescription(
  description: RTCSessionDescriptionInit,
  preference: RtcNetworkPreference,
  interfaces: readonly NetworkInterfaceDescriptor[],
): RTCSessionDescriptionInit {
  if (preference === "auto" || !description.sdp) return description;
  const separator = description.sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = description.sdp.split(separator).flatMap((line) => {
    if (!line.startsWith("a=candidate:")) return [line];
    const prepared = prepareLocalIceCandidate({ candidate: line }, preference, interfaces);
    return prepared?.candidate ? [prepared.candidate] : [];
  });
  return { ...description, sdp: lines.join(separator) };
}

function parseCandidate(value: string): { fields: string[]; address: string; type: string } | undefined {
  const prefix = value.startsWith("a=") ? "a=" : "";
  const fields = value.slice(prefix.length).trim().split(/\s+/);
  const typeIndex = fields.indexOf("typ");
  if (!fields[0]?.startsWith("candidate:") || fields.length < 8 || typeIndex < 0 || !fields[typeIndex + 1]) return undefined;
  if (prefix) fields[0] = `${prefix}${fields[0]}`;
  return { fields, address: fields[4]!, type: fields[typeIndex + 1]! };
}
