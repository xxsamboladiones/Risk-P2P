import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeshWebRTCTransport, WebScreenShareProvider } from "./index";

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static addedIce: RTCIceCandidateInit[] = [];
  static dataChannels: FakeDataChannel[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  constructor() { FakePeerConnection.instances.push(this); }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: "offer" }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = descriptionWithJson(description);
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = descriptionWithJson(description);
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> { FakePeerConnection.addedIce.push(candidate); }
  addTrack(): RTCRtpSender { return {} as RTCRtpSender; }
  removeTrack(): void {}
  getSenders(): RTCRtpSender[] { return []; }
  getTransceivers(): RTCRtpTransceiver[] { return []; }
  createDataChannel(label: string): RTCDataChannel { const channel = new FakeDataChannel(label); FakePeerConnection.dataChannels.push(channel); return channel as unknown as RTCDataChannel; }
  restartIce(): void {}
  close(): void { this.connectionState = "closed"; }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor(readonly label: string) {}
  open(): void { this.readyState = "open"; this.onopen?.(); }
  send(data: string): void { this.sent.push(data); }
  receive(data: string): void { this.onmessage?.(new MessageEvent("message", { data })); }
  close(): void { this.readyState = "closed"; this.onclose?.(); }
}

function descriptionWithJson(value: RTCSessionDescriptionInit): RTCSessionDescription {
  return { type: value.type!, sdp: value.sdp ?? "", toJSON: () => value } as RTCSessionDescription;
}

describe("WebScreenShareProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("seleciona a única fonte Electron antes de chamar getDisplayMedia", async () => {
    const selectScreenSource = vi.fn(async () => undefined);
    const getDisplayMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    vi.stubGlobal("desktop", {
      listScreenSources: vi.fn(async () => [{ id: "screen:1:0", name: "Tela 1" }]),
      selectScreenSource,
    });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });

    const provider = new WebScreenShareProvider();
    const stream = await provider.startScreenShare();

    expect(selectScreenSource).toHaveBeenCalledWith("screen:1:0");
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(stream).toBeDefined();
  });

  it("mantém o picker nativo do navegador quando não há bridge Electron", async () => {
    const getDisplayMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });

    const provider = new WebScreenShareProvider();
    await provider.startScreenShare();

    expect(getDisplayMedia).toHaveBeenCalledOnce();
  });
});

describe("MeshWebRTCTransport", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    FakePeerConnection.addedIce = [];
    FakePeerConnection.dataChannels = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mantém no máximo uma RTCPeerConnection por peer", async () => {
    const transport = new MeshWebRTCTransport("00000000-0000-4000-8000-000000000001", [], events());
    await transport.connect("00000000-0000-4000-8000-000000000002", false);
    await transport.connect("00000000-0000-4000-8000-000000000002", false);
    expect(FakePeerConnection.instances).toHaveLength(1);
    await transport.disconnect();
  });

  it("mantém cinco conexões remotas para uma chamada Mesh de seis participantes", async () => {
    const transport = new MeshWebRTCTransport("00000000-0000-4000-8000-000000000001", [], events());
    for (let index = 2; index <= 6; index += 1) {
      await transport.connect(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, false);
    }
    expect(FakePeerConnection.instances).toHaveLength(5);
    expect(transport.getDiagnostics()).toHaveLength(5);
    await expect(transport.connect("00000000-0000-4000-8000-000000000007", false)).rejects.toThrow("Sala cheia");
    expect(transport.getDiagnostics()).toHaveLength(5);
    await transport.disconnect();
  });

  it("enfileira ICE até remoteDescription e depois processa a fila", async () => {
    const callbacks = events();
    const transport = new MeshWebRTCTransport("00000000-0000-4000-8000-000000000002", [], callbacks);
    const candidate = { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 };
    await transport.addIceCandidate("00000000-0000-4000-8000-000000000001", candidate);
    expect(FakePeerConnection.addedIce).toHaveLength(0);
    expect(transport.getDiagnostics()[0]?.pendingIceCandidates).toBe(1);
    await transport.acceptOffer("00000000-0000-4000-8000-000000000001", { type: "offer", sdp: "offer" });
    expect(FakePeerConnection.addedIce).toEqual([candidate]);
    expect(callbacks.sendAnswer).toHaveBeenCalledOnce();
    expect(transport.getDiagnostics()[0]?.pendingIceCandidates).toBe(0);
  });

  it("abre um DataChannel por peer e entrega mensagens sem servidor", async () => {
    const callbacks = { ...events(), onDataMessage: vi.fn(), onDataState: vi.fn() };
    const transport = new MeshWebRTCTransport("00000000-0000-4000-8000-000000000001", [], callbacks);
    await transport.connect("00000000-0000-4000-8000-000000000002", true);
    const channel = FakePeerConnection.dataChannels[0]!; channel.open();
    expect(transport.sendData('{"type":"chat.message"}')).toBe(1);
    expect(channel.sent).toEqual(['{"type":"chat.message"}']);
    channel.receive("mensagem recebida");
    expect(callbacks.onDataMessage).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", "mensagem recebida");
    await transport.disconnect();
    expect(channel.readyState).toBe("closed");
  });

  it("não envia em DataChannel congestionado", async () => {
    const callbacks = { ...events(), onDataMessage: vi.fn(), onDataState: vi.fn() };
    const transport = new MeshWebRTCTransport("00000000-0000-4000-8000-000000000001", [], callbacks);
    await transport.connect("00000000-0000-4000-8000-000000000002", true);
    const channel = FakePeerConnection.dataChannels[0]!;
    channel.open();
    channel.bufferedAmount = 600 * 1024;
    expect(transport.sendData("mensagem")).toBe(0);
    expect(channel.sent).toHaveLength(0);
  });
});

function events() {
  return {
    sendOffer: vi.fn(), sendAnswer: vi.fn(), sendIce: vi.fn(),
    onRemoteStream: vi.fn(), onConnectionState: vi.fn(),
  };
}
