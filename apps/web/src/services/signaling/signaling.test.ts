import { describe, expect, it, vi } from "vitest";
import { InMemorySignalingHub, InMemorySignalingProvider } from "./in-memory";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";

describe("InMemorySignalingProvider", () => {
  it("conecta, anuncia presença e remove o peer no cleanup", async () => {
    const hub = new InMemorySignalingHub();
    const a = new InMemorySignalingProvider(hub); const b = new InMemorySignalingProvider(hub);
    const joined = vi.fn(); const left = vi.fn();
    a.onPeerJoined(joined); a.onPeerLeft(left);
    await a.connect("room", A); await b.connect("room", B);
    expect(joined).toHaveBeenCalledWith(expect.objectContaining({ peerId: B }));
    expect(a.getDiagnostics().presencePeers).toEqual([B]);
    await b.disconnect();
    expect(left).toHaveBeenCalledWith(B);
    expect(hub.roomSize("room")).toBe(1);
    await a.disconnect();
    expect(hub.roomSize("room")).toBe(0);
  });

  it("entrega offer, answer e ICE somente ao target", async () => {
    const hub = new InMemorySignalingHub();
    const a = new InMemorySignalingProvider(hub); const b = new InMemorySignalingProvider(hub); const c = new InMemorySignalingProvider(hub);
    const offerB = vi.fn(); const offerC = vi.fn(); const answerA = vi.fn(); const iceB = vi.fn();
    b.onOffer(offerB); c.onOffer(offerC); a.onAnswer(answerA); b.onIceCandidate(iceB);
    await a.connect("room", A); await b.connect("room", B); await c.connect("room", C);
    await a.sendOffer(B, { type: "offer", sdp: "offer-sdp" });
    await b.sendAnswer(A, { type: "answer", sdp: "answer-sdp" });
    await a.sendIceCandidate(B, { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
    expect(offerB).toHaveBeenCalledOnce(); expect(offerC).not.toHaveBeenCalled();
    expect(answerA).toHaveBeenCalledOnce(); expect(iceB).toHaveBeenCalledOnce();
  });

  it("envia o nome necessário por Broadcast efêmero, fora do Presence", async () => {
    const hub = new InMemorySignalingHub();
    const a = new InMemorySignalingProvider(hub); const b = new InMemorySignalingProvider(hub);
    const profile = vi.fn(); b.onPeerProfile(profile);
    await a.connect("room", A); await b.connect("room", B);
    await a.sendPeerProfile("Maria");
    expect(profile).toHaveBeenCalledWith(expect.objectContaining({ payload: { displayName: "Maria" } }));
    expect(a.getDiagnostics().presencePeers).toEqual([B]);
  });

  it("ignora mensagens próprias e duplicadas", async () => {
    const hub = new InMemorySignalingHub();
    const a = new InMemorySignalingProvider(hub); const b = new InMemorySignalingProvider(hub);
    const received = vi.fn(); const selfReceived = vi.fn(); b.onOffer(received); a.onOffer(selfReceived);
    await a.connect("room", A); await b.connect("room", B);
    await a.sendOffer(B, { type: "offer", sdp: "offer-sdp" });
    hub.replayLast("room");
    expect(received).toHaveBeenCalledOnce();
    expect(selfReceived).not.toHaveBeenCalled();
  });
});

describe("fluxo WebRTC sobre signaling mockado", () => {
  it("coordena Offer → Answer → ICE → conectado", async () => {
    const hub = new InMemorySignalingHub();
    const a = new InMemorySignalingProvider(hub); const b = new InMemorySignalingProvider(hub);
    const events: string[] = [];
    a.onPeerJoined((peer) => { if (A < peer.peerId) void a.sendOffer(peer.peerId, { type: "offer", sdp: "offer" }); });
    b.onOffer((message) => { events.push("offer"); void b.sendAnswer(message.fromPeerId, { type: "answer", sdp: "answer" }); });
    a.onAnswer((message) => { events.push("answer"); void a.sendIceCandidate(message.fromPeerId, { candidate: "candidate:1" }); });
    b.onIceCandidate(() => { events.push("ice", "connected"); });
    await a.connect("mesh-room", A); await b.connect("mesh-room", B);
    await vi.waitFor(() => expect(events).toEqual(["offer", "answer", "ice", "connected"]));
  });

  it("mantém presença Mesh para seis participantes", async () => {
    const hub = new InMemorySignalingHub();
    const providers = Array.from({ length: 6 }, () => new InMemorySignalingProvider(hub));
    for (const [index, provider] of providers.entries()) {
      await provider.connect("six-peer-room", `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    }
    providers.forEach((provider) => expect(provider.getDiagnostics().presencePeers).toHaveLength(5));
    for (const provider of providers) await provider.disconnect();
    expect(hub.roomSize("six-peer-room")).toBe(0);
  });
});
