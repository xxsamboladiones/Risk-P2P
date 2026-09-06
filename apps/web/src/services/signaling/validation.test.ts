import { describe, expect, it } from "vitest";
import { parseIceCandidate, parseOffer, parsePeerState } from "./validation";

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

  it("recusa timestamp inválido, IDs inválidos e SDP excessivo", () => {
    const invalidTimestamp = envelope("webrtc.offer", { sdp: { type: "offer", sdp: "v=0" } });
    invalidTimestamp.timestamp = Number.NaN;
    expect(parseOffer(invalidTimestamp)).toBeNull();
    expect(parseOffer({ ...envelope("webrtc.offer", { sdp: { type: "offer", sdp: "v=0" } }), fromPeerId: "email@example.test" })).toBeNull();
    expect(parseOffer(envelope("webrtc.offer", { sdp: { type: "offer", sdp: "x".repeat(60_001) } }))).toBeNull();
  });

  it("recusa ICE excessivo e estado malformado", () => {
    expect(parseIceCandidate(envelope("webrtc.ice-candidate", { candidate: { candidate: "x".repeat(4_097) } }))).toBeNull();
    expect(parsePeerState(envelope("peer.state", { state: { microphone: "yes", camera: false, screenShare: false } }))).toBeNull();
  });

  it("deixa a política temporal para o provider registrar diferença de relógio", () => {
    const skewed = envelope("webrtc.offer", { sdp: { type: "offer", sdp: "v=0" } });
    skewed.timestamp = Date.now() + 4 * 60_000;
    expect(parseOffer(skewed)).not.toBeNull();
  });
});
