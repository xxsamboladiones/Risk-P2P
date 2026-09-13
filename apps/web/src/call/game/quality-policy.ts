import type { PeerConnectionDiagnostics } from "@risk/rtc";

type Quality = "720p60" | "1080p60";
export function gameQuality(current: Quality, diagnostics: PeerConnectionDiagnostics[]): Quality {
  const peers = diagnostics.filter((peer) => peer.connectionState === "connected");
  if (!peers.length) return current;
  const congested = peers.length > 2 || peers.some((p) =>
    (p.roundTripTimeMs ?? 0) > 90 || (p.packetLossPercent ?? 0) > 2 || (p.jitterMs ?? 0) > 25
    || (p.videoEncodeMs ?? 0) > 16
    || (p.availableOutgoingKbps !== undefined && p.availableOutgoingKbps < 10000));
  if (congested) return "720p60";
  const headroom = peers.every((p) => p.roundTripTimeMs !== undefined && p.roundTripTimeMs < 60
    && (p.availableOutgoingKbps ?? 0) >= 12000 && p.videoEncodeMs !== undefined && p.videoEncodeMs < 12
    && (p.packetLossPercent ?? 0) < 1 && (p.jitterMs ?? 0) < 15);
  return headroom ? "1080p60" : current;
}
