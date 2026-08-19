import type { IceCandidatePayload, PeerState } from "@risk/protocol";
import { MediaDeviceError, logger } from "@risk/shared";

export type ScreenSource = { id: string; name: string; thumbnail?: string; displayId?: string };
export interface ScreenShareProvider {
  getSources(): Promise<ScreenSource[]>;
  startScreenShare(sourceId?: string): Promise<MediaStream>;
  stopScreenShare(): Promise<void>;
}

export class WebScreenShareProvider implements ScreenShareProvider {
  private stream?: MediaStream;
  async getSources(): Promise<ScreenSource[]> { return []; }
  async startScreenShare(): Promise<MediaStream> {
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    return this.stream;
  }
  async stopScreenShare(): Promise<void> {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}

export class DeviceManager extends EventTarget {
  constructor() {
    super();
    navigator.mediaDevices.addEventListener("devicechange", () => this.dispatchEvent(new Event("change")));
  }
  async list(): Promise<MediaDeviceInfo[]> { return navigator.mediaDevices.enumerateDevices(); }
  async getMicrophone(deviceId?: string): Promise<MediaStreamTrack> {
    try {
      return (await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } : true })).getAudioTracks()[0]!;
    } catch (error) { throw new MediaDeviceError("Não foi possível acessar o microfone", error); }
  }
  async getCamera(deviceId?: string): Promise<MediaStreamTrack> {
    try {
      return (await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : true })).getVideoTracks()[0]!;
    } catch (error) { throw new MediaDeviceError("Não foi possível acessar a câmera", error); }
  }
}

export interface TransportEvents {
  sendOffer(peerId: string, description: RTCSessionDescriptionInit): void | Promise<void>;
  sendAnswer(peerId: string, description: RTCSessionDescriptionInit): void | Promise<void>;
  sendIce(peerId: string, candidate: IceCandidatePayload): void | Promise<void>;
  onRemoteStream(peerId: string, stream: MediaStream): void;
  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;
  onDataMessage?(peerId: string, data: string): void;
  onDataState?(peerId: string, state: RTCDataChannelState): void;
}

export type PeerConnectionDiagnostics = {
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  pendingIceCandidates: number;
  dataChannelState: RTCDataChannelState | "unavailable";
};

export interface CallTransport {
  connect(peerId: string, initiator: boolean): Promise<void>;
  disconnect(peerId?: string): Promise<void>;
  publishTrack(track: MediaStreamTrack, stream: MediaStream): Promise<void>;
  unpublishTrack(track: MediaStreamTrack): Promise<void>;
  replaceTrack(kind: "audio" | "video", track: MediaStreamTrack | null): Promise<void>;
}

type PeerEntry = {
  pc: RTCPeerConnection;
  canNegotiate: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
  dataChannel?: RTCDataChannel;
};

export class MeshWebRTCTransport implements CallTransport {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly localTracks = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();

  constructor(
    private readonly localPeerId: string,
    private readonly iceServers: RTCIceServer[],
    private readonly events: TransportEvents,
  ) {}

  async connect(peerId: string, initiator: boolean): Promise<void> {
    const entry = this.peers.get(peerId) ?? this.createPeer(peerId);
    entry.canNegotiate = initiator;
    if (initiator && this.events.onDataMessage && !entry.dataChannel) {
      this.bindDataChannel(peerId, entry, entry.pc.createDataChannel("risk.chat", { ordered: true }));
    }
    if (initiator) await this.negotiate(peerId, entry);
  }

  async acceptOffer(peerId: string, description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type !== "offer") throw new Error("Descrição WebRTC não é uma offer.");
    await this.acceptDescription(peerId, description);
  }

  async acceptAnswer(peerId: string, description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type !== "answer") throw new Error("Descrição WebRTC não é uma answer.");
    await this.acceptDescription(peerId, description);
  }

  async addIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const entry = this.peers.get(peerId) ?? this.createPeer(peerId);
    if (entry.ignoreOffer) return;
    if (!entry.pc.remoteDescription) {
      if (entry.pendingIceCandidates.length < 256) entry.pendingIceCandidates.push(candidate);
      return;
    }
    await entry.pc.addIceCandidate(candidate);
  }

  async publishTrack(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    this.localTracks.set(track.id, { track, stream });
    this.peers.forEach(({ pc }) => {
      if (!pc.getSenders().some((sender) => sender.track?.id === track.id)) pc.addTrack(track, stream);
    });
  }

  async unpublishTrack(track: MediaStreamTrack): Promise<void> {
    this.localTracks.delete(track.id);
    this.peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find((item) => item.track === track);
      if (sender) pc.removeTrack(sender);
    });
  }

  async replaceTrack(kind: "audio" | "video", track: MediaStreamTrack | null): Promise<void> {
    await Promise.all([...this.peers.values()].map(async ({ pc }) => {
      const sender = pc.getTransceivers().find((item) => item.sender.track?.kind === kind || item.receiver.track.kind === kind)?.sender;
      if (sender) await sender.replaceTrack(track);
    }));
  }

  sendData(data: string, targetPeerId?: string): number {
    if (new TextEncoder().encode(data).byteLength > 64 * 1024) throw new Error("Mensagem DataChannel excede 64 KiB.");
    let sent = 0;
    for (const [peerId, entry] of this.peers) {
      if (targetPeerId && peerId !== targetPeerId) continue;
      if (entry.dataChannel?.readyState === "open") { entry.dataChannel.send(data); sent += 1; }
    }
    return sent;
  }

  async restartIce(peerId: string): Promise<void> {
    const entry = this.requirePeer(peerId);
    entry.pc.restartIce();
    await this.negotiate(peerId, entry, true);
  }

  async disconnect(peerId?: string): Promise<void> {
    const ids = peerId ? [peerId] : [...this.peers.keys()];
    ids.forEach((id) => {
      const entry = this.peers.get(id);
      if (!entry) return;
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onnegotiationneeded = null;
      entry.pc.onconnectionstatechange = null;
      entry.pendingIceCandidates.length = 0;
      entry.dataChannel?.close();
      entry.pc.close();
      this.peers.delete(id);
    });
  }

  getDiagnostics(): PeerConnectionDiagnostics[] {
    return [...this.peers].map(([peerId, entry]) => ({
      peerId,
      connectionState: entry.pc.connectionState,
      iceConnectionState: entry.pc.iceConnectionState,
      signalingState: entry.pc.signalingState,
      pendingIceCandidates: entry.pendingIceCandidates.length,
      dataChannelState: entry.dataChannel?.readyState ?? "unavailable",
    }));
  }

  private createPeer(peerId: string): PeerEntry {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry: PeerEntry = { pc, canNegotiate: false, makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false, pendingIceCandidates: [] };
    this.peers.set(peerId, entry);
    this.localTracks.forEach(({ track, stream }) => pc.addTrack(track, stream));
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) void Promise.resolve(this.events.sendIce(peerId, candidate.toJSON() as IceCandidatePayload)).catch((error) => logger.warn("ICE signaling failed", { peerId, error: String(error) }));
    };
    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (stream) this.events.onRemoteStream(peerId, stream);
    };
    pc.ondatachannel = ({ channel }) => this.bindDataChannel(peerId, entry, channel);
    pc.onnegotiationneeded = () => { if (entry.canNegotiate) void this.negotiate(peerId, entry); };
    pc.onconnectionstatechange = () => {
      this.events.onConnectionState(peerId, pc.connectionState);
      if (pc.connectionState === "failed" && this.localPeerId < peerId) {
        void this.restartIce(peerId).catch((error) => logger.warn("ICE restart failed", { peerId, error: String(error) }));
      }
    };
    return entry;
  }

  private bindDataChannel(peerId: string, entry: PeerEntry, channel: RTCDataChannel): void {
    if (entry.dataChannel && entry.dataChannel !== channel) entry.dataChannel.close();
    entry.dataChannel = channel;
    channel.onopen = () => this.events.onDataState?.(peerId, channel.readyState);
    channel.onclose = () => this.events.onDataState?.(peerId, channel.readyState);
    channel.onerror = () => this.events.onDataState?.(peerId, channel.readyState);
    channel.onmessage = ({ data }) => {
      if (typeof data === "string" && new TextEncoder().encode(data).byteLength <= 64 * 1024) this.events.onDataMessage?.(peerId, data);
    };
  }

  private async acceptDescription(peerId: string, description: RTCSessionDescriptionInit): Promise<void> {
    const entry = this.peers.get(peerId) ?? this.createPeer(peerId);
    const { pc } = entry;
    const readyForOffer = !entry.makingOffer && (pc.signalingState === "stable" || entry.settingRemoteAnswer);
    const offerCollision = description.type === "offer" && !readyForOffer;
    const polite = this.localPeerId > peerId;
    entry.ignoreOffer = !polite && offerCollision;
    if (entry.ignoreOffer) return;
    entry.settingRemoteAnswer = description.type === "answer";
    try {
      if (offerCollision && pc.signalingState !== "stable") {
        await Promise.all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(description)]);
      } else {
        await pc.setRemoteDescription(description);
      }
    } finally { entry.settingRemoteAnswer = false; }
    await this.flushPendingIce(entry);
    entry.canNegotiate = true;
    if (description.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (pc.localDescription) await this.events.sendAnswer(peerId, pc.localDescription.toJSON());
    }
  }

  private async flushPendingIce(entry: PeerEntry): Promise<void> {
    const candidates = entry.pendingIceCandidates.splice(0);
    for (const candidate of candidates) await entry.pc.addIceCandidate(candidate);
  }

  private requirePeer(peerId: string): PeerEntry {
    const entry = this.peers.get(peerId);
    if (!entry) throw new Error(`Peer desconhecido: ${peerId}`);
    return entry;
  }

  private async negotiate(peerId: string, entry: PeerEntry, iceRestart = false): Promise<void> {
    if (entry.makingOffer || entry.pc.signalingState !== "stable") return;
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer({ iceRestart });
      if (entry.pc.signalingState !== "stable") return;
      await entry.pc.setLocalDescription(offer);
      if (entry.pc.localDescription) await this.events.sendOffer(peerId, entry.pc.localDescription.toJSON());
    } catch (error) {
      logger.warn("WebRTC renegotiation failed", { peerId, error: String(error) });
    } finally { entry.makingOffer = false; }
  }
}

export function defaultPeerState(): PeerState { return { microphone: true, camera: false, screenShare: false }; }
