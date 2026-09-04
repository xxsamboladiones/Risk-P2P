import type { PeerConnectionDiagnostics } from "../transport/call-transport";

export type ConnectionQuality = "good" | "degraded" | "poor";

export function connectionQuality(diagnostics: readonly PeerConnectionDiagnostics[]): ConnectionQuality {
  if (diagnostics.some((peer) => (peer.roundTripTimeMs ?? 0) > 600 || (peer.jitterMs ?? 0) > 100 || (peer.packetsLost ?? 0) > 50)) {
    return "poor";
  }
  if (diagnostics.some((peer) => (peer.roundTripTimeMs ?? 0) > 350 || (peer.jitterMs ?? 0) > 60 || (peer.packetsLost ?? 0) > 20)) {
    return "degraded";
  }
  return "good";
}
