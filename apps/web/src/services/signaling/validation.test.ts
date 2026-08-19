import { describe, expect, it, vi } from "vitest";
import { parseIceCandidate, parseOffer, parsePeerProfile, parsePeerState } from "./validation";

const FROM = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const ROOM = "a".repeat(64);

function envelope(type: string, payload: unknown) {
  return {
    version: 1, roomId: ROOM, fromPeerId: FROM, targetPeerId: TARGET,
    messageId: crypto.randomUUID(), timestamp: Date.now(), type, payload,
  };
}

describe("validação de signaling externo", () => {
  it("aceita uma offer tipada válida", () => {
    expect(parseOffer(envelope("webrtc.offer", { sdp: { type: "offer", sdp: "v=0" } }))).not.toBeNull();
  });

  it("recusa mensagens antigas, IDs inválidos e SDP excessivo", () => {
    const old = envelope("webrtc.offer", { sdp: { type: "offer", sdp: "v=0" } });
    old.timestamp = Date.now() - 121_000;
    expect(parseOffer(old)).toBeNull();
    expect(parseOffer({ ...envelope("webrtc.offer", { sdp: { type: "offer", sdp: "v=0" } }), fromPeerId: "email@example.test" })).toBeNull();
    expect(parseOffer(envelope("webrtc.offer", { sdp: { type: "offer", sdp: "x".repeat(60_001) } }))).toBeNull();
  });

  it("recusa ICE excessivo e estado malformado", () => {
    expect(parseIceCandidate(envelope("webrtc.ice-candidate", { candidate: { candidate: "x".repeat(4_097) } }))).toBeNull();
    expect(parsePeerState(envelope("peer.state", { state: { microphone: "yes", camera: false, screenShare: false } }))).toBeNull();
  });

  it("aceita apenas nomes de exibição pequenos e válidos", () => {
    expect(parsePeerProfile(envelope("peer.profile", { displayName: "Maria" }))).not.toBeNull();
    expect(parsePeerProfile(envelope("peer.profile", { displayName: "M" }))).toBeNull();
    expect(parsePeerProfile(envelope("peer.profile", { displayName: "x".repeat(101) }))).toBeNull();
  });

  it("recusa timestamp futuro", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const future = envelope("webrtc.offer", { sdp: { type: "offer", sdp: "v=0" } });
    future.timestamp = Date.now() + 31_000;
    expect(parseOffer(future)).toBeNull();
    vi.useRealTimers();
  });
});
