import { MeshWebRTCTransport, WebScreenShareProvider } from "@risk/rtc";
import { parseServerMessage, type ClientMessage, type PeerState } from "@risk/protocol";
import { useCallStore } from "./store";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080/ws";
export class CallController {
  private ws?: WebSocket; private transport?: MeshWebRTCTransport; private local = new MediaStream(); private screen = new WebScreenShareProvider();
  private cameraTrack?: MediaStreamTrack; private screenStream?: MediaStream;
  private state: PeerState = { microphone: true, camera: false, screenShare: false }; private heartbeat?: number;
  async join(token: string, roomId: string, iceServers: RTCIceServer[]): Promise<MediaStream> {
    this.transport = new MeshWebRTCTransport(iceServers, {
      sendOffer: (targetPeerId, sdp) => this.send({ type: "offer", roomId, targetPeerId, payload: { sdp } }),
      sendAnswer: (targetPeerId, sdp) => this.send({ type: "answer", roomId, targetPeerId, payload: { sdp } }),
      sendIce: (targetPeerId, candidate) => this.send({ type: "ice-candidate", roomId, targetPeerId, payload: candidate }),
      onRemoteStream: (peerId, stream) => { const old = useCallStore.getState().participants[peerId]; if (old) useCallStore.getState().upsert({ ...old, streams: { ...old.streams, [stream.id]: stream } }); },
      onConnectionState: (peerId, connection) => { const old = useCallStore.getState().participants[peerId]; if (old) useCallStore.getState().upsert({ ...old, connection }); }
    });
    const microphone = (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })).getAudioTracks()[0]!;
    this.local.addTrack(microphone); await this.transport.publishTrack(microphone, this.local);
    this.state.cameraStreamId = this.local.id;
    this.updateLocalPreview();
    this.ws = new WebSocket(WS_URL); this.ws.onmessage = (event) => void this.onMessage(String(event.data));
    await new Promise<void>((resolve, reject) => { this.ws!.onopen = () => { this.send({ type: "authenticate", token }); this.send({ type: "join-room", roomId }); resolve(); }; this.ws!.onerror = () => reject(new Error("Falha ao conectar à sala")); });
    this.heartbeat = window.setInterval(() => this.send({ type: "heartbeat" }), 20_000); return this.local;
  }
  async toggleMicrophone(roomId: string): Promise<void> { const track = this.local.getAudioTracks()[0]; if (!track) return; track.enabled = !track.enabled; this.state.microphone = track.enabled; this.updateLocalPreview(); this.sendState(roomId); }
  async toggleCamera(roomId: string): Promise<void> { if (this.cameraTrack) { await this.transport?.unpublishTrack(this.cameraTrack); this.cameraTrack.stop(); this.local.removeTrack(this.cameraTrack); this.cameraTrack = undefined; this.state.camera = false; } else { this.cameraTrack = (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })).getVideoTracks()[0]!; this.local.addTrack(this.cameraTrack); await this.transport?.publishTrack(this.cameraTrack, this.local); this.state.camera = true; } this.updateLocalPreview(); this.sendState(roomId); }
  async toggleScreen(roomId: string): Promise<void> { if (this.screenStream) { await this.stopScreen(roomId); } else { const stream = await this.screen.startScreenShare(); const videoTrack = stream.getVideoTracks()[0]; if (!videoTrack) throw new Error("A fonte selecionada não forneceu vídeo"); this.screenStream = stream; videoTrack.addEventListener("ended", () => void this.stopScreen(roomId)); await Promise.all(stream.getTracks().map((track) => this.transport!.publishTrack(track, stream))); this.state.screenShare = true; this.state.screenStreamId = stream.id; this.state.screenAudio = stream.getAudioTracks().length > 0; this.updateLocalPreview(); this.sendState(roomId); } }
  async leave(roomId: string): Promise<void> { this.send({ type: "leave-room", roomId }); clearInterval(this.heartbeat); this.ws?.close(); this.local.getTracks().forEach((track) => track.stop()); this.screenStream?.getTracks().forEach((track) => track.stop()); await this.transport?.disconnect(); useCallStore.getState().setLocalMedia({ camera: null, screen: null }, { microphone: true, camera: false, screenShare: false }); }
  private sendState(roomId: string): void { this.send({ type: "peer-state", roomId, state: this.state }); }
  private async stopScreen(roomId: string): Promise<void> { if (!this.screenStream) return; const stream = this.screenStream; this.screenStream = undefined; await Promise.all(stream.getTracks().map((track) => this.transport!.unpublishTrack(track))); await this.screen.stopScreenShare(); this.state.screenShare = false; this.state.screenStreamId = undefined; this.state.screenAudio = false; this.updateLocalPreview(); this.sendState(roomId); }
  private updateLocalPreview(): void { useCallStore.getState().setLocalMedia({ camera: this.cameraTrack ? new MediaStream([this.cameraTrack]) : null, screen: this.screenStream ? new MediaStream(this.screenStream.getVideoTracks()) : null }, this.state); }
  private send(message: ClientMessage): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  private async onMessage(raw: string): Promise<void> { const message = parseServerMessage(raw); const store = useCallStore.getState(); switch (message.type) {
    case "authenticated": store.setSelf(message.peerId); break;
    case "room-joined": message.peers.forEach((peer) => { store.upsert(peer); void this.transport?.connect(peer.peerId, true); }); break;
    case "peer-joined": store.upsert(message); break; case "peer-left": store.remove(message.peerId); await this.transport?.disconnect(message.peerId); break;
    case "offer": await this.transport?.acceptOffer(message.fromPeerId, message.payload.sdp); break; case "answer": await this.transport?.acceptAnswer(message.fromPeerId, message.payload.sdp); break;
    case "ice-candidate": await this.transport?.addIceCandidate(message.fromPeerId, message.payload); break;
    case "peer-state": { const old = store.participants[message.peerId]; if (old) store.upsert({ ...old, state: message.state }); break; }
    case "error": store.setError(message.message); break;
  } }
}
