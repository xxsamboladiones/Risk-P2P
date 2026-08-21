import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { PeerState } from "@risk/protocol";
import { getSupabaseRealtimeClient } from "./client";
import { isValidPeer, parseAnswer, parseIceCandidate, parseOffer, parsePeerProfile, parsePeerState } from "../signaling/validation";
import type {
  AnswerMessage,
  IceCandidateMessage,
  OfferMessage,
  PeerProfileMessage,
  PeerStateMessage,
  SignalingDiagnostics,
  SignalingEnvelope,
  SignalingPeer,
  SignalingProvider,
  SignalingNamespace,
  SignalingStatus,
} from "../signaling/types";

type CallbackMap = {
  peerJoined: (peer: SignalingPeer) => void;
  peerLeft: (peerId: string) => void;
  offer: (message: OfferMessage) => void;
  answer: (message: AnswerMessage) => void;
  ice: (message: IceCandidateMessage) => void;
  peerState: (message: PeerStateMessage) => void;
  peerProfile: (message: PeerProfileMessage) => void;
  status: (status: SignalingStatus) => void;
};

type CallbackSets = { [Key in keyof CallbackMap]: Set<CallbackMap[Key]> };
type RateWindow = { startedAt: number; count: number };

const DEBUG = import.meta.env.VITE_DEBUG_SIGNALING === "true";
const CLIENT_VERSION = "risk-web-1";

export class SupabaseSignalingProvider implements SignalingProvider {
  private readonly callbacks: CallbackSets = {
    peerJoined: new Set(), peerLeft: new Set(), offer: new Set(), answer: new Set(),
    ice: new Set(), peerState: new Set(), peerProfile: new Set(), status: new Set(),
  };
  private readonly presencePeers = new Map<string, SignalingPeer>();
  private readonly processedMessageIds = new Map<string, number>();
  private readonly rateWindows = new Map<string, RateWindow>();
  private channel?: RealtimeChannel;
  private client?: SupabaseClient;
  private roomId?: string;
  private peerId?: string;
  private status: SignalingStatus = "disconnected";
  private channelStatus = "CLOSED";
  private disconnecting = false;

  async connect(roomId: string, peerId: string, namespace: SignalingNamespace = "room"): Promise<void> {
    if (this.channel) await this.disconnect();
    this.disconnecting = false;
    this.setStatus("connecting");
    this.client = getSupabaseRealtimeClient();
    this.roomId = await secureRoomId(`${namespace}:${roomId}`);
    this.peerId = peerId;
    const channelName = `risk:${namespace}:${this.roomId.slice(0, 32)}`;
    this.channel = this.client.channel(channelName, {
      config: { presence: { key: peerId }, broadcast: { self: false, ack: true } },
    });
    this.registerChannelListeners(this.channel);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) { settled = true; this.setStatus("error"); reject(new Error("Tempo esgotado ao conectar ao Supabase Realtime.")); }
      }, 15_000);
      this.channel!.subscribe(async (status) => {
        this.channelStatus = status;
        if (status === "SUBSCRIBED") {
          this.setStatus("connected");
          try {
            await this.channel!.track({ peerId, joinedAt: Date.now(), clientVersion: CLIENT_VERSION });
            this.reconcilePresence();
            if (!settled) { settled = true; window.clearTimeout(timeout); resolve(); }
          } catch (error) {
            if (!settled) { settled = true; window.clearTimeout(timeout); reject(error); }
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          this.setStatus(settled ? "reconnecting" : "error");
          if (!settled) { settled = true; window.clearTimeout(timeout); reject(new Error(`Falha no canal Supabase Realtime: ${status}`)); }
        } else if (status === "CLOSED" && !this.disconnecting) {
          this.setStatus("disconnected");
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    const channel = this.channel;
    this.channel = undefined;
    if (channel) {
      try { await channel.untrack(); } catch { /* channel may already be closed */ }
      if (this.client) await this.client.removeChannel(channel);
    }
    for (const peerId of this.presencePeers.keys()) this.emit("peerLeft", peerId);
    this.presencePeers.clear();
    this.processedMessageIds.clear();
    this.rateWindows.clear();
    this.roomId = undefined;
    this.peerId = undefined;
    this.channelStatus = "CLOSED";
    this.setStatus("disconnected");
    this.disconnecting = false;
  }

  sendOffer(targetPeerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    return this.broadcast("webrtc.offer", targetPeerId, { sdp: offer });
  }
  sendAnswer(targetPeerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    return this.broadcast("webrtc.answer", targetPeerId, { sdp: answer });
  }
  sendIceCandidate(targetPeerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    return this.broadcast("webrtc.ice-candidate", targetPeerId, { candidate });
  }
  sendPeerState(state: PeerState): Promise<void> { return this.broadcast("peer.state", undefined, { state }); }
  sendPeerProfile(displayName: string): Promise<void> { return this.broadcast("peer.profile", undefined, { displayName: displayName.trim() }); }

  onPeerJoined(callback: CallbackMap["peerJoined"]): () => void { return this.addCallback("peerJoined", callback); }
  onPeerLeft(callback: CallbackMap["peerLeft"]): () => void { return this.addCallback("peerLeft", callback); }
  onOffer(callback: CallbackMap["offer"]): () => void { return this.addCallback("offer", callback); }
  onAnswer(callback: CallbackMap["answer"]): () => void { return this.addCallback("answer", callback); }
  onIceCandidate(callback: CallbackMap["ice"]): () => void { return this.addCallback("ice", callback); }
  onPeerState(callback: CallbackMap["peerState"]): () => void { return this.addCallback("peerState", callback); }
  onPeerProfile(callback: CallbackMap["peerProfile"]): () => void { return this.addCallback("peerProfile", callback); }
  onStatusChange(callback: CallbackMap["status"]): () => void { return this.addCallback("status", callback); }

  getDiagnostics(): SignalingDiagnostics {
    return {
      status: this.status, channelStatus: this.channelStatus, peerId: this.peerId ?? null,
      roomId: this.roomId ?? null, connectedPeers: [...this.presencePeers.keys()],
      presencePeers: [...this.presencePeers.keys()], processedMessages: this.processedMessageIds.size,
    };
  }

  private registerChannelListeners(channel: RealtimeChannel): void {
    channel
      .on("presence", { event: "sync" }, () => this.reconcilePresence())
      .on("broadcast", { event: "webrtc.offer" }, ({ payload }) => this.receive("offer", parseOffer(payload)))
      .on("broadcast", { event: "webrtc.answer" }, ({ payload }) => this.receive("answer", parseAnswer(payload)))
      .on("broadcast", { event: "webrtc.ice-candidate" }, ({ payload }) => this.receive("ice", parseIceCandidate(payload)))
      .on("broadcast", { event: "peer.state" }, ({ payload }) => this.receive("peerState", parsePeerState(payload)))
      .on("broadcast", { event: "peer.profile" }, ({ payload }) => this.receive("peerProfile", parsePeerProfile(payload)));
  }

  private reconcilePresence(): void {
    const channel = this.channel;
    const ownPeerId = this.peerId;
    if (!channel || !ownPeerId) return;
    const next = new Map<string, SignalingPeer>();
    const state = channel.presenceState();
    for (const entries of Object.values(state)) {
      for (const entry of entries) {
        if (isValidPeer(entry) && entry.peerId !== ownPeerId) next.set(entry.peerId, entry);
      }
    }
    for (const [peerId, peer] of next) if (!this.presencePeers.has(peerId)) {
      this.presencePeers.set(peerId, peer); this.log("peer joined", peerId); this.emit("peerJoined", peer);
    }
    for (const peerId of this.presencePeers.keys()) if (!next.has(peerId)) {
      this.presencePeers.delete(peerId); this.log("peer left", peerId); this.emit("peerLeft", peerId);
    }
  }

  private receive<Key extends "offer" | "answer" | "ice" | "peerState" | "peerProfile">(key: Key, message: Parameters<CallbackMap[Key]>[0] | null): void {
    if (!message || !this.acceptMessage(message)) return;
    this.log(`${key} received`, message.fromPeerId);
    this.emit(key, message);
  }

  private acceptMessage(message: OfferMessage | AnswerMessage | IceCandidateMessage | PeerStateMessage | PeerProfileMessage): boolean {
    if (!this.peerId || !this.roomId || message.roomId !== this.roomId || message.fromPeerId === this.peerId) return false;
    if (message.targetPeerId !== undefined && message.targetPeerId !== this.peerId) return false;

    if (!this.presencePeers.has(message.fromPeerId)) {
      this.reconcilePresence();
      const targetedWebRtcMessage = message.targetPeerId === this.peerId
        && (message.type === "webrtc.offer" || message.type === "webrtc.answer" || message.type === "webrtc.ice-candidate");
      if (!this.presencePeers.has(message.fromPeerId) && !targetedWebRtcMessage) return false;
      if (!this.presencePeers.has(message.fromPeerId)) this.log("accepting WebRTC signaling before presence sync", message.fromPeerId);
    }

    this.pruneCaches();
    if (this.processedMessageIds.has(message.messageId)) return false;
    if (!this.withinRateLimit(message.fromPeerId, message.type)) return false;
    this.processedMessageIds.set(message.messageId, Date.now());
    return true;
  }

  private withinRateLimit(peerId: string, type: string): boolean {
    const key = `${peerId}:${type}`; const now = Date.now(); const existing = this.rateWindows.get(key);
    const limit = type === "webrtc.ice-candidate" ? 200 : 20;
    if (!existing || now - existing.startedAt > 10_000) { this.rateWindows.set(key, { startedAt: now, count: 1 }); return true; }
    existing.count += 1; return existing.count <= limit;
  }

  private pruneCaches(): void {
    const now = Date.now();
    const threshold = now - 120_000;
    for (const [id, timestamp] of this.processedMessageIds) if (timestamp < threshold) this.processedMessageIds.delete(id);
    for (const [key, window] of this.rateWindows) if (now - window.startedAt > 60_000) this.rateWindows.delete(key);
    if (this.processedMessageIds.size > 2_048) {
      const overflow = this.processedMessageIds.size - 2_048;
      [...this.processedMessageIds.keys()].slice(0, overflow).forEach((id) => this.processedMessageIds.delete(id));
    }
  }

  private async broadcast<Type extends string, Payload>(type: Type, targetPeerId: string | undefined, payload: Payload): Promise<void> {
    if (!this.channel || !this.roomId || !this.peerId || this.status !== "connected") throw new Error("Signaling Realtime não está conectado.");
    const envelope: SignalingEnvelope<Type, Payload> = {
      version: 1, roomId: this.roomId, fromPeerId: this.peerId, targetPeerId,
      messageId: crypto.randomUUID(), timestamp: Date.now(), type, payload,
    };
    const result = await this.channel.send({ type: "broadcast", event: type, payload: envelope });
    if (result !== "ok") throw new Error(`Falha ao enviar ${type} pelo Supabase Realtime.`);
  }

  private addCallback<Key extends keyof CallbackMap>(key: Key, callback: CallbackMap[Key]): () => void {
    const callbacks = this.callbacks[key] as Set<CallbackMap[Key]>; callbacks.add(callback);
    return () => callbacks.delete(callback);
  }
  private emit<Key extends keyof CallbackMap>(key: Key, value: Parameters<CallbackMap[Key]>[0]): void {
    const callbacks = this.callbacks[key] as Set<(item: Parameters<CallbackMap[Key]>[0]) => void>;
    callbacks.forEach((callback) => callback(value));
  }
  private setStatus(status: SignalingStatus): void { if (this.status === status) return; this.status = status; this.log(status); this.emit("status", status); }
  private log(event: string, peerId?: string): void { if (DEBUG) console.info(`[signaling] ${event}`, peerId ? { peerId } : undefined); }
}

async function secureRoomId(roomId: string): Promise<string> {
  const bytes = new TextEncoder().encode(roomId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
