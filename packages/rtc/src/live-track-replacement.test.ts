import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeshWebRTCTransport } from "./index";

class FakeSender {
  constructor(public track: MediaStreamTrack | null) {}
  async replaceTrack(track: MediaStreamTrack | null): Promise<void> { this.track = track; }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "connected";
  iceConnectionState: RTCIceConnectionState = "connected";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  readonly senders: FakeSender[] = [];

  constructor() { FakePeerConnection.instances.push(this); }
  addTrack(track: MediaStreamTrack): RTCRtpSender {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }
  removeTrack(sender: RTCRtpSender): void {
    const index = this.senders.indexOf(sender as unknown as FakeSender);
    if (index >= 0) this.senders.splice(index, 1);
  }
  getSenders(): RTCRtpSender[] { return this.senders as unknown as RTCRtpSender[]; }
  getTransceivers(): RTCRtpTransceiver[] { return []; }
  async addIceCandidate(): Promise<void> {}
  restartIce(): void {}
  close(): void { this.connectionState = "closed"; }
}

function track(id: string, kind: "audio" | "video" = "audio"): MediaStreamTrack {
  return { id, kind } as MediaStreamTrack;
}

function events() {
  return {
    sendOffer: vi.fn(),
    sendAnswer: vi.fn(),
    sendIce: vi.fn(),
    onRemoteStream: vi.fn(),
    onConnectionState: vi.fn(),
  };
}

describe("MeshWebRTCTransport.replacePublishedTrack", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("substitui apenas o microfone e preserva o áudio da tela", async () => {
    const transport = new MeshWebRTCTransport("peer-local", [], events());
    await transport.connect("peer-1", false);
    const microphone = track("mic-old");
    const screenAudio = track("screen-audio");
    const localStream = { id: "local-stream" } as MediaStream;
    const screenStream = { id: "screen-stream" } as MediaStream;
    await transport.publishTrack(microphone, localStream);
    await transport.publishTrack(screenAudio, screenStream);

    const replacement = track("mic-new");
    await transport.replacePublishedTrack(microphone, replacement, localStream);

    const firstPeerTracks = FakePeerConnection.instances[0]!.senders.map((sender) => sender.track?.id);
    expect(firstPeerTracks).toEqual(["mic-new", "screen-audio"]);

    await transport.connect("peer-2", false);
    const secondPeerTracks = FakePeerConnection.instances[1]!.senders.map((sender) => sender.track?.id);
    expect(secondPeerTracks).toEqual(["screen-audio", "mic-new"]);
  });
});
