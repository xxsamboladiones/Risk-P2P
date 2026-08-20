import type { IceCandidatePayload, PeerState } from "@risk/protocol";
import { MediaDeviceError, logger } from "@risk/shared";

export type ScreenSource = { id: string; name: string; thumbnail?: string; displayId?: string };
export interface ScreenShareProvider {
  getSources(): Promise<ScreenSource[]>;
  startScreenShare(sourceId?: string): Promise<MediaStream>;
  stopScreenShare(): Promise<void>;
}

type DesktopScreenBridge = {
  listScreenSources(): Promise<Array<{ id: string; name: string; thumbnail?: string; displayId?: string }>>;
  chooseScreenSource?(): Promise<string | null>;
  selectScreenSource(sourceId: string): Promise<void>;
};

type DisplayAudioConstraints = MediaTrackConstraints & { restrictOwnAudio?: boolean };
type DisplayAudioSettings = MediaTrackSettings & { restrictOwnAudio?: boolean };
type RiskMediaCaptureOptions = { restrictOwnAudio?: boolean };

function desktopScreenBridge(): DesktopScreenBridge | undefined {
  return (globalThis as typeof globalThis & { desktop?: DesktopScreenBridge }).desktop;
}

function riskMediaCaptureOptions(): RiskMediaCaptureOptions | undefined {
  return (globalThis as typeof globalThis & { __riskMediaCaptureOptions?: RiskMediaCaptureOptions }).__riskMediaCaptureOptions;
}

export class WebScreenShareProvider implements ScreenShareProvider {
  private stream?: MediaStream;

  async getSources(): Promise<ScreenSource[]> {
    const desktop = desktopScreenBridge();
    return desktop ? desktop.listScreenSources() : [];
  }

  async startScreenShare(sourceId?: string): Promise<MediaStream> {
    const desktop = desktopScreenBridge();
    if (desktop) {
      let selectedSourceId = sourceId;
      if (!selectedSourceId) {
        if (desktop.chooseScreenSource) {
          selectedSourceId = await desktop.chooseScreenSource() ?? undefined;
        } else {
          const sources = await desktop.listScreenSources();
          if (sources.length === 1) selectedSourceId = sources[0]?.id;
          else if (sources.length > 1) throw new Error("O seletor de tela do Electron não está disponível nesta versão do desktop.");
        }
      }
      if (!selectedSourceId) throw new DOMException("Compartilhamento cancelado.", "NotAllowedError");
      await desktop.selectScreenSource(selectedSourceId);
    }

    const restrictOwnAudio = riskMediaCaptureOptions()?.restrictOwnAudio === true;
    const audio: true | DisplayAudioConstraints = restrictOwnAudio ? { restrictOwnAudio: true } : true;
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio });

    if (restrictOwnAudio) {
      const audioTrack = this.stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings() as DisplayAudioSettings;
        console.info("Risk screen audio capture", {
          deviceId: settings.deviceId ?? "unknown",
          restrictOwnAudio: settings.restrictOwnAudio ?? "unknown",
        });
        if (desktop && settings.deviceId === "loopback") {
          console.warn("A captura ainda está usando loopback completo; o áudio do Risk pode retornar na transmissão.");
        }
      }
    }

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
  onTransferMessage?(peerId: string, data: ArrayBuffer): void;
  onTransferState?(peerId: string, state: RTCDataChannelState): void;
}

export type PeerConnectionDiagnostics = {
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  pendingIceCandidates: number;
  dataChannelState: RTCDataChannelState | "unavailable";
  transferDataChannelState: RTCDataChannelState | "unavailable";
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
  needsNegotiation: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
  dataChannel?: RTCDataChannel;
  transferDataChannel?: RTCDataChannel;
};

const DEFAULT_MAX_REMOTE_PEERS = 5;
const CONTROL_CHANNEL_LABEL = "risk.chat";
const TRANSFER_CHANNEL_LABEL = "risk.transfer";
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
const MAX_DATA_BUFFER_BYTES = 512 * 1024;
const MAX_TRANSFER_FRAME_BYTES = 320 * 1024;
const TRANSFER_HIGH_WATER_MARK_BYTES = 4 * 1024 * 1024;
const TRANSFER_LOW_WATER_MARK_BYTES = 1 * 1024 * 1024;

export class MeshWebRTCTransport implements CallTransport {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly localTracks = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();

  constructor(
    private readonly localPeerId: string,
    private readonly iceServers: RTCIceServer[],
    private readonly events: TransportEvents,
    private readonly maxRemotePeers = DEFAULT_MAX_REMOTE_PEERS,
  ) {
    if (!Number.isInteger(maxRemotePeers) || maxRemotePeers < 1) throw new Error("maxRemotePeers deve ser maior que zero.");
  }

  async connect(peerId: string, initiator: boolean): Promise<void> {
    const entry = this.peers.get(peerId) ?? this.createPeer(peerId);
    if (initiator) entry.canNegotiate = true;
    if (initiator && this.events.onDataMessage && !entry.dataChannel) {
      this.bindControlDataChannel(peerId, entry, entry.pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true }));
    }
    if (initiator && this.events.onTransferMessage && !entry.transferDataChannel) {
      this.bindTransferDataChannel(peerId, entry, entry.pc.createDataChannel(TRANSFER_CHANNEL_LABEL, { ordered: true }));
    }
    if (initiator) {
      entry.needsNegotiation = true;
      await this.negotiateIfNeeded(peerId, entry);
    }
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
    const negotiations: Promise<void>[] = [];
    for (const [peerId, entry] of this.peers) {
      if (entry.pc.getSenders().some((sender) => sender.track?.id === track.id)) continue;
      entry.pc.addTrack(track, stream);
      entry.needsNegotiation = true;
      negotiations.push(this.negotiateIfNeeded(peerId, entry));
    }
    await Promise.all(negotiations);
  }

  async unpublishTrack(track: MediaStreamTrack): Promise<void> {
    this.localTracks.delete(track.id);
    const negotiations: Promise<void>[] = [];
    for (const [peerId, entry] of this.peers) {
      const sender = entry.pc.getSenders().find((item) => item.track === track || item.track?.id === track.id);
      if (!sender) continue;
      entry.pc.removeTrack(sender);
      entry.needsNegotiation = true;
      negotiations.push(this.negotiateIfNeeded(peerId, entry));
    }
    await Promise.all(negotiations);
  }

  async replaceTrack(kind: "audio" | "video", track: MediaStreamTrack | null): Promise<void> {
    await Promise.all([...this.peers.values()].map(async ({ pc }) => {
      const sender = pc.getTransceivers().find((item) => item.sender.track?.kind === kind || item.receiver.track.kind === kind)?.sender;
      if (sender) await sender.replaceTrack(track);
    }));
  }

  sendData(data: string, targetPeerId?: string): number {
    if (new TextEncoder().encode(data).byteLength > MAX_CONTROL_MESSAGE_BYTES) throw new Error("Mensagem DataChannel excede 64 KiB.");
    let sent = 0;
    for (const [peerId, entry] of this.peers) {
      if (targetPeerId && peerId !== targetPeerId) continue;
      const channel = entry.dataChannel;
      if (channel?.readyState !== "open") continue;
      if (channel.bufferedAmount > MAX_DATA_BUFFER_BYTES) {
        logger.warn("DataChannel de controle congestionado; mensagem não enviada", { peerId, bufferedAmount: channel.bufferedAmount });
        continue;
      }
      channel.send(data);
      sent += 1;
    }
    return sent;
  }

  sendTransferData(data: ArrayBuffer | ArrayBufferView, targetPeerId?: string): number {
    const payload = exactArrayBuffer(data);
    if (payload.byteLength > MAX_TRANSFER_FRAME_BYTES) throw new Error("Frame do risk.transfer excede o limite permitido.");
    let sent = 0;
    for (const [peerId, entry] of this.peers) {
      if (targetPeerId && peerId !== targetPeerId) continue;
      const channel = entry.transferDataChannel;
      if (channel?.readyState !== "open") continue;
      if (channel.bufferedAmount > TRANSFER_HIGH_WATER_MARK_BYTES) continue;
      channel.send(payload);
      sent += 1;
    }
    return sent;
  }

  getTransferBufferedAmount(peerId: string): number {
    const channel = this.peers.get(peerId)?.transferDataChannel;
    return channel?.readyState === "open" ? channel.bufferedAmount : Number.POSITIVE_INFINITY;
  }

  isTransferChannelOpen(peerId: string): boolean {
    return this.peers.get(peerId)?.transferDataChannel?.readyState === "open";
  }

  async waitForTransferBufferedAmountLow(peerId: string, threshold = TRANSFER_LOW_WATER_MARK_BYTES): Promise<void> {
    const channel = this.requirePeer(peerId).transferDataChannel;
    if (!channel || channel.readyState !== "open") throw new Error(`Canal ${TRANSFER_CHANNEL_LABEL} indisponível para ${peerId}.`);
    if (channel.bufferedAmount <= threshold) return;
    channel.bufferedAmountLowThreshold = Math.max(0, threshold);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClosed);
        channel.removeEventListener("error", onClosed);
      };
      const onLow = () => { cleanup(); resolve(); };
      const onClosed = () => { cleanup(); reject(new Error(`Canal ${TRANSFER_CHANNEL_LABEL} foi fechado durante a transferência.`)); };
      channel.addEventListener("bufferedamountlow", onLow, { once: true });
      channel.addEventListener("close", onClosed, { once: true });
      channel.addEventListener("error", onClosed, { once: true });
    });
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
      entry.transferDataChannel?.close();
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
      transferDataChannelState: entry.transferDataChannel?.readyState ?? "unavailable",
    }));
  }

  private createPeer(peerId: string): PeerEntry {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    if (this.peers.size >= this.maxRemotePeers) {
      throw new Error(`Sala cheia: este cliente aceita no máximo ${this.maxRemotePeers + 1} participantes no Mesh.`);
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry: PeerEntry = {
      pc,
      canNegotiate: false,
      makingOffer: false,
      needsNegotiation: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      pendingIceCandidates: [],
    };
    this.peers.set(peerId, entry);
    this.localTracks.forEach(({ track, stream }) => pc.addTrack(track, stream));
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) void Promise.resolve(this.events.sendIce(peerId, candidate.toJSON() as IceCandidatePayload)).catch((error) => logger.warn("ICE signaling failed", { peerId, error: String(error) }));
    };
    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (stream) this.events.onRemoteStream(peerId, stream);
    };
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === TRANSFER_CHANNEL_LABEL) this.bindTransferDataChannel(peerId, entry, channel);
      else if (channel.label === CONTROL_CHANNEL_LABEL || channel.label === "risk.control") this.bindControlDataChannel(peerId, entry, channel);
      else channel.close();
    };
    pc.onnegotiationneeded = () => {
      if (!entry.canNegotiate) {
        entry.needsNegotiation = true;
        return;
      }
      if (entry.makingOffer || entry.pc.signalingState !== "stable") return;
      entry.needsNegotiation = true;
      void this.negotiateIfNeeded(peerId, entry);
    };
    pc.onconnectionstatechange = () => {
      this.events.onConnectionState(peerId, pc.connectionState);
      if (pc.connectionState === "failed" && this.localPeerId < peerId) {
        void this.restartIce(peerId).catch((error) => logger.warn("ICE restart failed", { peerId, error: String(error) }));
      }
    };
    return entry;
  }

  private bindControlDataChannel(peerId: string, entry: PeerEntry, channel: RTCDataChannel): void {
    if (entry.dataChannel && entry.dataChannel !== channel) entry.dataChannel.close();
    entry.dataChannel = channel;
    channel.onopen = () => this.events.onDataState?.(peerId, channel.readyState);
    channel.onclose = () => this.events.onDataState?.(peerId, channel.readyState);
    channel.onerror = () => this.events.onDataState?.(peerId, channel.readyState);
    channel.onmessage = ({ data }) => {
      if (typeof data === "string" && new TextEncoder().encode(data).byteLength <= MAX_CONTROL_MESSAGE_BYTES) this.events.onDataMessage?.(peerId, data);
    };
  }

  private bindTransferDataChannel(peerId: string, entry: PeerEntry, channel: RTCDataChannel): void {
    if (entry.transferDataChannel && entry.transferDataChannel !== channel) entry.transferDataChannel.close();
    entry.transferDataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = TRANSFER_LOW_WATER_MARK_BYTES;
    channel.onopen = () => this.events.onTransferState?.(peerId, channel.readyState);
    channel.onclose = () => this.events.onTransferState?.(peerId, channel.readyState);
    channel.onerror = () => this.events.onTransferState?.(peerId, channel.readyState);
    channel.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        if (data.byteLength <= MAX_TRANSFER_FRAME_BYTES) this.events.onTransferMessage?.(peerId, data);
        return;
      }
      if (data instanceof Blob && data.size <= MAX_TRANSFER_FRAME_BYTES) {
        void data.arrayBuffer().then((buffer) => this.events.onTransferMessage?.(peerId, buffer)).catch(() => undefined);
      }
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
      entry.needsNegotiation = false;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (pc.localDescription) await this.events.sendAnswer(peerId, pc.localDescription.toJSON());
    } else {
      await this.negotiateIfNeeded(peerId, entry);
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

  private async negotiateIfNeeded(peerId: string, entry: PeerEntry): Promise<void> {
    if (!entry.needsNegotiation || !entry.canNegotiate || entry.makingOffer || entry.pc.signalingState !== "stable") return;
    entry.needsNegotiation = false;
    await this.negotiate(peerId, entry);
  }

  private async negotiate(peerId: string, entry: PeerEntry, iceRestart = false): Promise<void> {
    if (entry.makingOffer || entry.pc.signalingState !== "stable") {
      if (!iceRestart) entry.needsNegotiation = true;
      return;
    }
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer({ iceRestart });
      if (entry.pc.signalingState !== "stable") {
        if (!iceRestart) entry.needsNegotiation = true;
        return;
      }
      await entry.pc.setLocalDescription(offer);
      if (entry.pc.localDescription) await this.events.sendOffer(peerId, entry.pc.localDescription.toJSON());
    } catch (error) {
      if (!iceRestart) entry.needsNegotiation = true;
      logger.warn("WebRTC renegotiation failed", { peerId, error: String(error) });
    } finally { entry.makingOffer = false; }
  }
}

function exactArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export function defaultPeerState(): PeerState { return { microphone: true, camera: false, screenShare: false }; }
