import type { MeshPeerEntry } from "./peer";

export const MAX_PENDING_ICE_CANDIDATES = 256;

export async function addOrQueueIceCandidate(
  entry: MeshPeerEntry,
  candidate: RTCIceCandidateInit,
): Promise<"added" | "queued" | "ignored"> {
  if (entry.ignoreOffer) return "ignored";
  if (!entry.pc.remoteDescription) {
    if (entry.pendingIceCandidates.length < MAX_PENDING_ICE_CANDIDATES) {
      entry.pendingIceCandidates.push(candidate);
    }
    return "queued";
  }
  await entry.pc.addIceCandidate(candidate);
  return "added";
}

export async function flushPendingIceCandidates(entry: MeshPeerEntry): Promise<void> {
  const candidates = entry.pendingIceCandidates.splice(0);
  for (const candidate of candidates) await entry.pc.addIceCandidate(candidate);
}
