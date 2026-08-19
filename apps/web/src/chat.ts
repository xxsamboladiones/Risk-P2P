import { MeshWebRTCTransport } from "@risk/rtc";
import { SupabaseSignalingProvider } from "./services/supabase/signaling";
import type { SignalingProvider } from "./services/signaling/types";
import { loadLocalMessages, saveLocalMessage, type LocalChatMessage } from "./services/offline/chat-storage";

export type ChatConnectionStatus = "disconnected" | "connecting" | "connected" | "ready" | "error";
type ChatWireMessage = {
  version: 1;
  type: "chat.message";
  channelId: string;
  id: string;
  author: string;
  content: string;
  timestamp: number;
};

export class ChatController {
  private signaling?: SignalingProvider;
  private transport?: MeshWebRTCTransport;
  private channelId?: string;
  private peerId?: string;
  private displayName = "Participante";
  private status: ChatConnectionStatus = "disconnected";
  private readonly processed = new Set<string>();
  private readonly openDataPeers = new Set<string>();
  private readonly peerNames = new Map<string, string>();
  private readonly messageCallbacks = new Set<(message: LocalChatMessage) => void>();
  private readonly statusCallbacks = new Set<(status: ChatConnectionStatus) => void>();
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly createSignaling: () => SignalingProvider = () => new SupabaseSignalingProvider()) {}

  history(channelId: string): Promise<LocalChatMessage[]> { return loadLocalMessages(channelId); }

  async connect(channelId: string, displayName: string, iceServers: RTCIceServer[]): Promise<void> {
    await this.disconnect();
    this.setStatus("connecting");
    this.channelId = channelId;
    this.peerId = crypto.randomUUID();
    this.displayName = displayName.trim();
    this.signaling = this.createSignaling();
    this.transport = new MeshWebRTCTransport(this.peerId, iceServers, {
      sendOffer: (targetPeerId, description) => this.signaling!.sendOffer(targetPeerId, description),
      sendAnswer: (targetPeerId, description) => this.signaling!.sendAnswer(targetPeerId, description),
      sendIce: (targetPeerId, candidate) => this.signaling!.sendIceCandidate(targetPeerId, candidate),
      onRemoteStream: () => undefined,
      onConnectionState: (remotePeerId, state) => {
        if (state === "failed" || state === "closed") {
          this.openDataPeers.delete(remotePeerId);
          this.setStatus(this.openDataPeers.size > 0 ? "ready" : "connected");
        }
      },
      onDataMessage: (remotePeerId, data) => { void this.receive(remotePeerId, data); },
      onDataState: (remotePeerId, state) => {
        if (state === "open") this.openDataPeers.add(remotePeerId); else this.openDataPeers.delete(remotePeerId);
        this.setStatus(this.openDataPeers.size > 0 ? "ready" : "connected");
      },
    });
    this.bindSignaling(this.signaling, this.peerId);
    try {
      await this.signaling.connect(channelId, this.peerId, "chat");
      this.setStatus("connected");
      await this.signaling.sendPeerProfile(this.displayName);
    } catch (error) { await this.disconnect(); this.setStatus("error"); throw error; }
  }

  async disconnect(): Promise<void> {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    await this.signaling?.disconnect().catch(() => undefined);
    await this.transport?.disconnect().catch(() => undefined);
    this.signaling = undefined; this.transport = undefined; this.channelId = undefined; this.peerId = undefined;
    this.openDataPeers.clear(); this.peerNames.clear(); this.processed.clear(); this.setStatus("disconnected");
  }

  async send(content: string): Promise<LocalChatMessage> {
    if (!this.channelId || !this.transport) throw new Error("Conecte o chat primeiro.");
    if (this.openDataPeers.size === 0) throw new Error("Aguardando outro participante conectar o chat.");
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 4_000) throw new Error("Mensagem inválida.");
    const timestamp = Date.now();
    const wire: ChatWireMessage = { version: 1, type: "chat.message", channelId: this.channelId, id: crypto.randomUUID(), author: this.displayName, content: trimmed, timestamp };
    if (this.transport.sendData(JSON.stringify(wire)) === 0) throw new Error("Nenhuma conexão P2P disponível ou os canais estão congestionados.");
    const local = toLocal(wire, this.displayName);
    this.remember(local.id);
    await saveLocalMessage(local);
    this.emitMessage(local);
    return local;
  }

  onMessage(callback: (message: LocalChatMessage) => void): () => void { this.messageCallbacks.add(callback); return () => this.messageCallbacks.delete(callback); }
  onStatus(callback: (status: ChatConnectionStatus) => void): () => void { this.statusCallbacks.add(callback); return () => this.statusCallbacks.delete(callback); }

  private bindSignaling(signaling: SignalingProvider, peerId: string): void {
    this.unsubscribers.push(
      signaling.onPeerJoined((peer) => {
        void this.transport?.connect(peer.peerId, peerId < peer.peerId).catch(() => this.setStatus(this.openDataPeers.size ? "ready" : "connected"));
        void signaling.sendPeerProfile(this.displayName).catch(() => undefined);
      }),
      signaling.onPeerLeft((remotePeerId) => {
        this.openDataPeers.delete(remotePeerId);
        this.peerNames.delete(remotePeerId);
        void this.transport?.disconnect(remotePeerId);
        this.setStatus(this.openDataPeers.size ? "ready" : "connected");
      }),
      signaling.onOffer((message) => { void this.transport?.acceptOffer(message.fromPeerId, message.payload.sdp).catch(() => this.setStatus(this.openDataPeers.size ? "ready" : "connected")); }),
      signaling.onAnswer((message) => { void this.transport?.acceptAnswer(message.fromPeerId, message.payload.sdp).catch(() => this.setStatus(this.openDataPeers.size ? "ready" : "connected")); }),
      signaling.onIceCandidate((message) => { void this.transport?.addIceCandidate(message.fromPeerId, message.payload.candidate).catch(() => undefined); }),
      signaling.onPeerProfile((message) => {
        if (!this.peerNames.has(message.fromPeerId)) this.peerNames.set(message.fromPeerId, message.payload.displayName);
      }),
      signaling.onStatusChange((status) => {
        if (status === "reconnecting" && this.openDataPeers.size === 0) this.setStatus("connecting");
        if (status === "error" && this.openDataPeers.size === 0) this.setStatus("error");
      }),
    );
  }

  private async receive(remotePeerId: string, raw: string): Promise<void> {
    const wire = parseChatWireMessage(raw, this.channelId);
    if (!wire || this.processed.has(wire.id)) return;
    this.remember(wire.id);
    const trustedDisplayName = this.peerNames.get(remotePeerId) ?? `Peer ${remotePeerId.slice(0, 6)}`;
    const local = toLocal(wire, trustedDisplayName);
    await saveLocalMessage(local);
    this.emitMessage(local);
  }

  private remember(messageId: string): void {
    this.processed.add(messageId);
    while (this.processed.size > 2_048) this.processed.delete(this.processed.values().next().value!);
  }

  private emitMessage(message: LocalChatMessage): void { this.messageCallbacks.forEach((callback) => callback(message)); }
  private setStatus(status: ChatConnectionStatus): void { if (this.status === status) return; this.status = status; this.statusCallbacks.forEach((callback) => callback(status)); }
}

export function parseChatWireMessage(raw: string, channelId?: string): ChatWireMessage | null {
  if (new TextEncoder().encode(raw).byteLength > 16 * 1024) return null;
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>; const now = Date.now();
  return message.version === 1 && message.type === "chat.message" && message.channelId === channelId
    && typeof message.id === "string" && /^[0-9a-f-]{36}$/i.test(message.id)
    && typeof message.author === "string" && message.author.trim().length >= 2 && message.author.length <= 80
    && typeof message.content === "string" && message.content.trim().length > 0 && message.content.length <= 4_000
    && typeof message.timestamp === "number" && Number.isFinite(message.timestamp) && message.timestamp >= now - 120_000 && message.timestamp <= now + 30_000
    ? message as ChatWireMessage : null;
}

function toLocal(message: ChatWireMessage, author: string): LocalChatMessage {
  return { id: message.id, channelId: message.channelId, author, content: message.content, createdAt: new Date(message.timestamp).toISOString() };
}
