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
  async stopScreenShare(): Promise<void> { this.stream?.getTracks().forEach((track) => track.stop()); this.stream = undefined; }
}

export class DeviceManager extends EventTarget {
  constructor() { super(); navigator.mediaDevices.addEventListener("devicechange", () => this.dispatchEvent(new Event("change"))); }
  async list(): Promise<MediaDeviceInfo[]> { return navigator.mediaDevices.enumerateDevices(); }
  async getMicrophone(deviceId?: string): Promise<MediaStreamTrack> {
    try { return (await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } : true })).getAudioTracks()[0]!; }
    catch (error) { throw new MediaDeviceError("Não foi possível acessar o microfone", error); }
  }
  async getCamera(deviceId?: string): Promise<MediaStreamTrack> {
    try { return (await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : true })).getVideoTracks()[0]!; }
    catch (error) { throw new MediaDeviceError("Não foi possível acessar a câmera", error); }
  }
}

export interface TransportEvents {
  sendOffer(peerId: string, sdp: string): void;
  sendAnswer(peerId: string, sdp: string): void;
  sendIce(peerId: string, candidate: IceCandidatePayload): void;
  onRemoteStream(peerId: string, stream: MediaStream): void;
  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;
}

export interface CallTransport {
  connect(peerId: string, initiator: boolean): Promise<void>;
  disconnect(peerId?: string): Promise<void>;
  publishTrack(track: MediaStreamTrack, stream: MediaStream): Promise<void>;
  unpublishTrack(track: MediaStreamTrack): Promise<void>;
  replaceTrack(kind: "audio" | "video", track: MediaStreamTrack | null): Promise<void>;
}

export class MeshWebRTCTransport implements CallTransport {
  private peers = new Map<string, RTCPeerConnection>();
  private makingOffer = new Set<string>();
  private localTracks = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();
  constructor(private readonly iceServers: RTCIceServer[], private readonly events: TransportEvents) {}

  async connect(peerId: string, initiator: boolean): Promise<void> {
    const pc = this.createPeer(peerId);
    if (initiator) {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      this.events.sendOffer(peerId, offer.sdp!);
    }
  }
  async acceptOffer(peerId: string, sdp: string): Promise<void> {
    const pc = this.peers.get(peerId) ?? this.createPeer(peerId);
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    this.events.sendAnswer(peerId, answer.sdp!);
  }
  async acceptAnswer(peerId: string, sdp: string): Promise<void> { await this.requirePeer(peerId).setRemoteDescription({ type: "answer", sdp }); }
  async addIceCandidate(peerId: string, candidate: IceCandidatePayload): Promise<void> { await this.requirePeer(peerId).addIceCandidate(candidate); }
  async publishTrack(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    this.localTracks.set(track.id, { track, stream }); this.peers.forEach((pc) => pc.addTrack(track, stream));
  }
  async unpublishTrack(track: MediaStreamTrack): Promise<void> {
    this.localTracks.delete(track.id); this.peers.forEach((pc) => { const sender = pc.getSenders().find((item) => item.track === track); if (sender) pc.removeTrack(sender); });
  }
  async replaceTrack(kind: "audio" | "video", track: MediaStreamTrack | null): Promise<void> {
    await Promise.all([...this.peers.values()].map(async (pc) => { const sender = pc.getTransceivers().find((item) => item.sender.track?.kind === kind || item.receiver.track.kind === kind)?.sender; if (sender) await sender.replaceTrack(track); }));
  }
  async restartIce(peerId: string): Promise<void> { const pc = this.requirePeer(peerId); pc.restartIce(); const offer = await pc.createOffer({ iceRestart: true }); await pc.setLocalDescription(offer); this.events.sendOffer(peerId, offer.sdp!); }
  async disconnect(peerId?: string): Promise<void> { const ids = peerId ? [peerId] : [...this.peers.keys()]; ids.forEach((id) => { this.peers.get(id)?.close(); this.peers.delete(id); }); }
  private createPeer(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers }); this.peers.set(peerId, pc);
    this.localTracks.forEach(({ track, stream }) => pc.addTrack(track, stream));
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.events.sendIce(peerId, candidate.toJSON() as IceCandidatePayload); };
    pc.ontrack = ({ streams }) => { const stream = streams[0]; if (stream) this.events.onRemoteStream(peerId, stream); };
    pc.onnegotiationneeded = () => { void this.renegotiate(peerId, pc); };
    pc.onconnectionstatechange = () => { this.events.onConnectionState(peerId, pc.connectionState); if (pc.connectionState === "failed") void this.restartIce(peerId).catch((error) => logger.warn("ICE restart failed", { error: String(error) })); };
    return pc;
  }
  private requirePeer(peerId: string): RTCPeerConnection { const pc = this.peers.get(peerId); if (!pc) throw new Error(`Peer desconhecido: ${peerId}`); return pc; }
  private async renegotiate(peerId: string, pc: RTCPeerConnection): Promise<void> {
    if (pc.signalingState !== "stable" || this.makingOffer.has(peerId)) return;
    this.makingOffer.add(peerId);
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      this.events.sendOffer(peerId, offer.sdp!);
    } catch (error) {
      logger.warn("WebRTC renegotiation failed", { peerId, error: String(error) });
    } finally {
      this.makingOffer.delete(peerId);
    }
  }
}

export function defaultPeerState(): PeerState { return { microphone: true, camera: false, screenShare: false }; }
