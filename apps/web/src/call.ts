import { MeshWebRTCTransport, WebScreenShareProvider, type PeerConnectionDiagnostics } from "@risk/rtc";
import type { PeerState } from "@risk/protocol";
import { useCallStore } from "./store";
import { api } from "./api";
import { SupabaseSignalingProvider } from "./services/supabase/signaling";
import type { SignalingDiagnostics, SignalingProvider } from "./services/signaling/types";

export type CallDiagnostics = {
  signaling: SignalingDiagnostics | null;
  peerConnections: PeerConnectionDiagnostics[];
};

export class CallController {
  private signaling?: SignalingProvider;
  private transport?: MeshWebRTCTransport;
  private local = new MediaStream();
  private readonly screen = new WebScreenShareProvider();
  private cameraTrack?: MediaStreamTrack;
  private screenStream?: MediaStream;
  private roomId?: string;
  private peerId?: string;
  private displayName = "Participante";
  private state: PeerState = { microphone: true, camera: false, screenShare: false };
  private signalingUnsubscribers: Array<() => void> = [];

  constructor(private readonly createSignaling: () => SignalingProvider = () => new SupabaseSignalingProvider()) {}

  async join(token: string, roomId: string, iceServers: RTCIceServer[]): Promise<MediaStream> {
    if (this.roomId) await this.leave(this.roomId);
    this.roomId = roomId;
    this.peerId = crypto.randomUUID();
    this.local = new MediaStream();
    this.cameraTrack = undefined;
    this.screenStream = undefined;
    this.state = { microphone: true, camera: false, screenShare: false };
    const store = useCallStore.getState();
    store.setSelf(this.peerId);

    this.signaling = this.createSignaling();
    this.transport = new MeshWebRTCTransport(this.peerId, iceServers, {
      sendOffer: (targetPeerId, description) => this.signaling!.sendOffer(targetPeerId, description),
      sendAnswer: (targetPeerId, description) => this.signaling!.sendAnswer(targetPeerId, description),
      sendIce: (targetPeerId, candidate) => this.signaling!.sendIceCandidate(targetPeerId, candidate),
      onRemoteStream: (remotePeerId, stream) => {
        const participant = useCallStore.getState().participants[remotePeerId];
        if (participant) useCallStore.getState().upsert({ ...participant, streams: { ...participant.streams, [stream.id]: stream } });
      },
      onConnectionState: (remotePeerId, connection) => {
        const participant = useCallStore.getState().participants[remotePeerId];
        if (participant) useCallStore.getState().upsert({ ...participant, connection });
      },
    });
    this.bindSignaling(this.signaling, roomId, this.peerId);

    try {
      const profile = await api.me(token);
      this.displayName = profile.displayName;
      const microphone = (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })).getAudioTracks()[0];
      if (!microphone) throw new Error("Nenhum microfone foi disponibilizado pelo navegador.");
      this.local.addTrack(microphone);
      await this.transport.publishTrack(microphone, this.local);
      this.state.cameraStreamId = this.local.id;
      this.updateLocalPreview();
      await this.signaling.connect(roomId, this.peerId);
      await Promise.all([this.signaling.sendPeerState(this.state), this.signaling.sendPeerProfile(this.displayName)]);
      return this.local;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async toggleMicrophone(_roomId: string): Promise<void> {
    const track = this.local.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.state.microphone = track.enabled;
    this.updateLocalPreview();
    await this.signaling?.sendPeerState(this.state);
  }

  async toggleCamera(_roomId: string): Promise<void> {
    if (this.cameraTrack) {
      await this.transport?.unpublishTrack(this.cameraTrack);
      this.cameraTrack.stop();
      this.local.removeTrack(this.cameraTrack);
      this.cameraTrack = undefined;
      this.state.camera = false;
    } else {
      const cameraTrack = (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })).getVideoTracks()[0];
      if (!cameraTrack) throw new Error("Nenhuma câmera foi disponibilizada pelo navegador.");
      this.cameraTrack = cameraTrack;
      this.local.addTrack(cameraTrack);
      await this.transport?.publishTrack(cameraTrack, this.local);
      this.state.camera = true;
    }
    this.updateLocalPreview();
    await this.signaling?.sendPeerState(this.state);
  }

  async toggleScreen(_roomId: string): Promise<void> {
    if (this.screenStream) { await this.stopScreen(); return; }
    const stream = await this.screen.startScreenShare();
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("A fonte selecionada não forneceu vídeo");
    this.screenStream = stream;
    videoTrack.addEventListener("ended", () => { void this.stopScreen(); }, { once: true });
    await Promise.all(stream.getTracks().map((track) => this.transport!.publishTrack(track, stream)));
    this.state.screenShare = true;
    this.state.screenStreamId = stream.id;
    this.state.screenAudio = stream.getAudioTracks().length > 0;
    this.updateLocalPreview();
    await this.signaling?.sendPeerState(this.state);
  }

  async leave(_roomId: string): Promise<void> { await this.cleanup(); }

  getDiagnostics(): CallDiagnostics {
    return {
      signaling: this.signaling?.getDiagnostics() ?? null,
      peerConnections: this.transport?.getDiagnostics() ?? [],
    };
  }

  private bindSignaling(signaling: SignalingProvider, roomId: string, peerId: string): void {
    this.signalingUnsubscribers.push(
      signaling.onPeerJoined((peer) => {
        const store = useCallStore.getState();
        store.upsert({
          peerId: peer.peerId,
          displayName: `Peer ${peer.peerId.slice(0, 6)}`,
          state: { microphone: true, camera: false, screenShare: false },
          streams: {},
          connection: "new",
        });
        void this.transport?.connect(peer.peerId, peerId < peer.peerId).catch((error) => store.setError(String(error)));
        void signaling.sendPeerState(this.state).catch((error) => store.setError(String(error)));
        void signaling.sendPeerProfile(this.displayName).catch((error) => store.setError(String(error)));
      }),
      signaling.onPeerLeft((remotePeerId) => {
        useCallStore.getState().remove(remotePeerId);
        void this.transport?.disconnect(remotePeerId);
      }),
      signaling.onOffer((message) => {
        void this.transport?.acceptOffer(message.fromPeerId, message.payload.sdp).catch((error) => useCallStore.getState().setError(String(error)));
      }),
      signaling.onAnswer((message) => {
        void this.transport?.acceptAnswer(message.fromPeerId, message.payload.sdp).catch((error) => useCallStore.getState().setError(String(error)));
      }),
      signaling.onIceCandidate((message) => {
        void this.transport?.addIceCandidate(message.fromPeerId, message.payload.candidate).catch((error) => useCallStore.getState().setError(String(error)));
      }),
      signaling.onPeerState((message) => {
        const store = useCallStore.getState();
        const participant = store.participants[message.fromPeerId] ?? {
          peerId: message.fromPeerId,
          displayName: `Peer ${message.fromPeerId.slice(0, 6)}`,
          streams: {},
        };
        store.upsert({ ...participant, state: message.payload.state });
      }),
      signaling.onPeerProfile((message) => {
        const store = useCallStore.getState();
        const participant = store.participants[message.fromPeerId] ?? {
          peerId: message.fromPeerId,
          displayName: message.payload.displayName,
          state: { microphone: true, camera: false, screenShare: false },
          streams: {},
        };
        store.upsert({ ...participant, displayName: message.payload.displayName });
      }),
      signaling.onStatusChange((status) => {
        if (status === "error") useCallStore.getState().setError("Falha no signaling Supabase Realtime.");
      }),
    );
    void roomId;
  }

  private async stopScreen(): Promise<void> {
    if (!this.screenStream) return;
    const stream = this.screenStream;
    this.screenStream = undefined;
    await Promise.all(stream.getTracks().map((track) => this.transport!.unpublishTrack(track)));
    await this.screen.stopScreenShare();
    this.state.screenShare = false;
    this.state.screenStreamId = undefined;
    this.state.screenAudio = false;
    this.updateLocalPreview();
    await this.signaling?.sendPeerState(this.state);
  }

  private updateLocalPreview(): void {
    useCallStore.getState().setLocalMedia({
      camera: this.cameraTrack ? new MediaStream([this.cameraTrack]) : null,
      screen: this.screenStream ? new MediaStream(this.screenStream.getVideoTracks()) : null,
    }, this.state);
  }

  private async cleanup(): Promise<void> {
    this.signalingUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    await this.signaling?.disconnect().catch(() => undefined);
    await this.transport?.disconnect().catch(() => undefined);
    this.local.getTracks().forEach((track) => track.stop());
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.cameraTrack = undefined;
    this.screenStream = undefined;
    this.signaling = undefined;
    this.transport = undefined;
    this.roomId = undefined;
    this.peerId = undefined;
    this.displayName = "Participante";
    useCallStore.getState().clearParticipants();
    useCallStore.getState().setLocalMedia({ camera: null, screen: null }, { microphone: true, camera: false, screenShare: false });
  }
}
