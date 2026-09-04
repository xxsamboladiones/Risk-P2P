import { describe, expect, it, vi } from "vitest";
import { addOrQueueIceCandidate, flushPendingIceCandidates, MAX_PENDING_ICE_CANDIDATES } from "./ice";
import { createMeshPeerEntry } from "./peer";

function peer(remoteDescription: RTCSessionDescription | null = null) {
  const addIceCandidate = vi.fn(async () => undefined);
  const pc = { remoteDescription, addIceCandidate } as unknown as RTCPeerConnection;
  return { entry: createMeshPeerEntry(pc), addIceCandidate };
}

describe("ICE candidate queue", () => {
  it("enfileira candidatos até existir uma descrição remota", async () => {
    const { entry, addIceCandidate } = peer();
    const candidate = { candidate: "candidate:1" };

    await expect(addOrQueueIceCandidate(entry, candidate)).resolves.toBe("queued");
    expect(entry.pendingIceCandidates).toEqual([candidate]);
    expect(addIceCandidate).not.toHaveBeenCalled();
  });

  it("limita a fila para evitar crescimento sem controle", async () => {
    const { entry } = peer();
    entry.pendingIceCandidates = Array.from({ length: MAX_PENDING_ICE_CANDIDATES }, (_, index) => ({ candidate: `candidate:${index}` }));

    await addOrQueueIceCandidate(entry, { candidate: "candidate:overflow" });
    expect(entry.pendingIceCandidates).toHaveLength(MAX_PENDING_ICE_CANDIDATES);
  });

  it("descarrega a fila em ordem", async () => {
    const { entry, addIceCandidate } = peer({ type: "offer", sdp: "v=0" } as RTCSessionDescription);
    const first = { candidate: "candidate:1" };
    const second = { candidate: "candidate:2" };
    entry.pendingIceCandidates.push(first, second);

    await flushPendingIceCandidates(entry);
    expect(addIceCandidate.mock.calls).toEqual([[first], [second]]);
    expect(entry.pendingIceCandidates).toEqual([]);
  });
});
