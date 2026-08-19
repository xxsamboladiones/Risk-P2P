import { MeshWebRTCTransport } from "@risk/rtc";
import { SupabaseSignalingProvider } from "./services/supabase/signaling";
import type { SignalingNamespace, SignalingProvider } from "./services/signaling/types";
import { loadLocalMessages, saveLocalMessage, type LocalChatMessage } from "./services/offline/chat-storage";
import type { LocalIdentity, PublicPeerIdentity } from "./services/offline/social-storage";

export type ChatConnectionStatus = "disconnected" | "connecting" | "connected" | "ready" | "error";

export type ChatConnectionOptions = {
  identity?: LocalIdentity;
  trustedPeers?: PublicPeerIdentity[];
  namespace?: SignalingNamespace;
  maxRemotePeers?: number;
};

type LegacyChatWireMessage = {
  version: 1;
  type: "chat.message";
  channelId: string;
  id: string;
  author: string;
  content: string;
  timestamp: number;
};

export type SignedChatWireMessage = {
  version: 2;
  type: "chat.message";
  channelId: string;
  id: string;
  authorPeerId: string;
  author: string;
  content: string;
  timestamp: number;
  signature: string;
};

type HistoryRequestWireMessage = {
  version: 2;
  type: "chat.history.request";
  channelId: string;
  requestId: string;
  knownIds: string[];
};

type HistoryChunkWireMessage = {
  version: 2;
  type: "chat.history.chunk";
  channelId: string;
  requestId: string;
  messages: SignedChatWireMessage[];
};

type HistoryCompleteWireMessage = {
  version: 2;
  type: "chat.history.complete";
  channelId: string;
  requestId: string;
};

type ChatWireMessage = LegacyChatWireMessage | SignedChatWireMessage;
type ChatWireEnvelope = ChatWireMessage | HistoryRequestWireMessage | HistoryChunkWireMessage | HistoryCompleteWireMessage;

const MAX_WIRE_BYTES = 64 * 1024;
const MAX_HISTORY_IDS = 200;
const HISTORY_CHUNK_MESSAGES = 8;
const LIVE_MESSAGE_MAX_AGE_MS = 120_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;

export class ChatController {
  private signaling?: SignalingProvider;
  private transport?: MeshWebRTCTransport;
  private channelId?: string;
  private peerId?: string;
  private displayName = "Participante";
  private identity?: LocalIdentity;
  private status: ChatConnectionStatus = "disconnected";
  private readonly processed = new Set<string>();
  private readonly openDataPeers = new Set<string>();
  private readonly peerNames = new Map<string, string>();
  private readonly trustedPeers = new Map<string, PublicPeerIdentity>();
  private readonly verifyKeys = new Map<string, Promise<CryptoKey>>();
  private readonly historyRequests = new Map<string, string>();
  private readonly messageCallbacks = new Set<(message: LocalChatMessage) => void>();
  private readonly statusCallbacks = new Set<(status: ChatConnectionStatus) => void>();
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly createSignaling: () => SignalingProvider = () => new SupabaseSignalingProvider()) {}

  history(channelId: string): Promise<LocalChatMessage[]> { return loadLocalMessages(channelId); }

  async connect(
    channelId: string,
    displayName: string,
    iceServers: RTCIceServer[],
    options: ChatConnectionOptions = {},
  ): Promise<void> {
    await this.disconnect();
    this.setStatus("connecting");
    this.channelId = channelId;
    this.identity = options.identity;
    this.peerId = options.identity?.peerId ?? crypto.randomUUID();
    this.displayName = displayName.trim();
    this.trustedPeers.clear();
    this.verifyKeys.clear();
    for (const peer of options.trustedPeers ?? []) this.trustedPeers.set(peer.peerId, peer);
    if (options.identity) {
      this.trustedPeers.set(options.identity.peerId, {
        peerId: options.identity.peerId,
        publicKey: options.identity.publicKey,
        displayName: options.identity.displayName,
        avatar: options.identity.avatar,
      });
    }
    this.peerNames.clear();
    this.trustedPeers.forEach((peer) => this.peerNames.set(peer.peerId, peer.displayName));

    this.signaling = this.createSignaling();
    this.transport = new MeshWebRTCTransport(this.peerId, iceServers, {
      sendOffer: (targetPeerId, description) => this.signaling!.sendOffer(targetPeerId, description),
      sendAnswer: (targetPeerId, description) => this.signaling!.sendAnswer(targetPeerId, description),
      sendIce: (targetPeerId, candidate) => this.signaling!.sendIceCandidate(targetPeerId, candidate),
      onRemoteStream: () => undefined,
      onConnectionState: (remotePeerId, state) => {
        if (state === "failed" || state === "closed") {
          this.openDataPeers.delete(remotePeerId);
          this.historyRequests.delete(remotePeerId);
          this.setStatus(this.openDataPeers.size > 0 ? "ready" : "connected");
        }
      },
      onDataMessage: (remotePeerId, data) => { void this.receive(remotePeerId, data); },
      onDataState: (remotePeerId, state) => {
        if (state === "open") {
          this.openDataPeers.add(remotePeerId);
          void this.requestHistory(remotePeerId);
        } else {
          this.openDataPeers.delete(remotePeerId);
          this.historyRequests.delete(remotePeerId);
        }
        this.setStatus(this.openDataPeers.size > 0 ? "ready" : "connected");
      },
    }, options.maxRemotePeers);
    this.bindSignaling(this.signaling, this.peerId);
    try {
      await this.signaling.connect(channelId, this.peerId, options.namespace ?? "chat");
      this.setStatus("connected");
      await this.signaling.sendPeerProfile(this.displayName);
    } catch (error) { await this.disconnect(); this.setStatus("error"); throw error; }
  }

  async disconnect(): Promise<void> {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    await this.signaling?.disconnect().catch(() => undefined);
    await this.transport?.disconnect().catch(() => undefined);
    this.signaling = undefined;
    this.transport = undefined;
    this.channelId = undefined;
    this.peerId = undefined;
    this.identity = undefined;
    this.openDataPeers.clear();
    this.peerNames.clear();
    this.trustedPeers.clear();
    this.verifyKeys.clear();
    this.historyRequests.clear();
    this.processed.clear();
    this.setStatus("disconnected");
  }

  async send(content: string): Promise<LocalChatMessage> {
    if (!this.channelId || !this.transport) throw new Error("Conecte o chat primeiro.");
    if (this.openDataPeers.size === 0) throw new Error("Aguardando outro participante conectar o chat.");
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 4_000) throw new Error("Mensagem inválida.");
    const timestamp = Date.now();

    if (this.identity) {
      const unsigned: Omit<SignedChatWireMessage, "signature"> = {
        version: 2,
        type: "chat.message",
        channelId: this.channelId,
        id: crypto.randomUUID(),
        authorPeerId: this.identity.peerId,
        author: this.displayName,
        content: trimmed,
        timestamp,
      };
      const wire: SignedChatWireMessage = { ...unsigned, signature: await this.signMessage(unsigned) };
      if (this.transport.sendData(JSON.stringify(wire)) === 0) {
        throw new Error("Nenhuma conexão P2P disponível ou os canais estão congestionados.");
      }
      const local = signedToLocal(wire);
      this.remember(local.id);
      await saveLocalMessage(local);
      this.emitMessage(local);
      return local;
    }

    const wire: LegacyChatWireMessage = {
      version: 1,
      type: "chat.message",
      channelId: this.channelId,
      id: crypto.randomUUID(),
      author: this.displayName,
      content: trimmed,
      timestamp,
    };
    if (this.transport.sendData(JSON.stringify(wire)) === 0) {
      throw new Error("Nenhuma conexão P2P disponível ou os canais estão congestionados.");
    }
    const local = legacyToLocal(wire, this.displayName);
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
        if (!this.isTrustedRemote(peer.peerId)) return;
        void this.transport?.connect(peer.peerId, peerId < peer.peerId).catch(() => this.setStatus(this.openDataPeers.size ? "ready" : "connected"));
        void signaling.sendPeerProfile(this.displayName).catch(() => undefined);
      }),
      signaling.onPeerLeft((remotePeerId) => {
        if (!this.isTrustedRemote(remotePeerId)) return;
        this.openDataPeers.delete(remotePeerId);
        this.historyRequests.delete(remotePeerId);
        if (!this.identity) this.peerNames.delete(remotePeerId);
        void this.transport?.disconnect(remotePeerId);
        this.setStatus(this.openDataPeers.size ? "ready" : "connected");
      }),
      signaling.onOffer((message) => {
        if (!this.isTrustedRemote(message.fromPeerId)) return;
        void this.transport?.acceptOffer(message.fromPeerId, message.payload.sdp).catch(() => this.setStatus(this.openDataPeers.size ? "ready" : "connected"));
      }),
      signaling.onAnswer((message) => {
        if (!this.isTrustedRemote(message.fromPeerId)) return;
        void this.transport?.acceptAnswer(message.fromPeerId, message.payload.sdp).catch(() => this.setStatus(this.openDataPeers.size ? "ready" : "connected"));
      }),
      signaling.onIceCandidate((message) => {
        if (!this.isTrustedRemote(message.fromPeerId)) return;
        void this.transport?.addIceCandidate(message.fromPeerId, message.payload.candidate).catch(() => undefined);
      }),
      signaling.onPeerProfile((message) => {
        if (!this.isTrustedRemote(message.fromPeerId)) return;
        if (!this.peerNames.has(message.fromPeerId)) this.peerNames.set(message.fromPeerId, message.payload.displayName);
      }),
      signaling.onStatusChange((status) => {
        if (status === "reconnecting" && this.openDataPeers.size === 0) this.setStatus("connecting");
        if (status === "error" && this.openDataPeers.size === 0) this.setStatus("error");
      }),
    );
  }

  private isTrustedRemote(remotePeerId: string): boolean {
    if (!this.identity) return remotePeerId !== this.peerId;
    return remotePeerId !== this.identity.peerId && this.trustedPeers.has(remotePeerId);
  }

  private async receive(remotePeerId: string, raw: string): Promise<void> {
    if (!this.isTrustedRemote(remotePeerId)) return;
    const envelope = parseChatWireEnvelope(raw, this.channelId);
    if (!envelope) return;

    if (envelope.type === "chat.message") {
      if (this.processed.has(envelope.id)) return;
      if (envelope.version === 2) {
        if (!this.identity || envelope.authorPeerId !== remotePeerId || !(await this.verifySignedMessage(envelope))) return;
        this.remember(envelope.id);
        const local = signedToLocal(envelope);
        await saveLocalMessage(local);
        this.emitMessage(local);
        return;
      }
      if (this.identity) return;
      this.remember(envelope.id);
      const trustedDisplayName = this.peerNames.get(remotePeerId) ?? `Peer ${remotePeerId.slice(0, 6)}`;
      const local = legacyToLocal(envelope, trustedDisplayName);
      await saveLocalMessage(local);
      this.emitMessage(local);
      return;
    }

    if (!this.identity) return;
    if (envelope.type === "chat.history.request") {
      await this.respondHistory(remotePeerId, envelope);
      return;
    }
    if (envelope.type === "chat.history.chunk") {
      if (this.historyRequests.get(remotePeerId) !== envelope.requestId) return;
      for (const message of envelope.messages) {
        if (this.processed.has(message.id) || !(await this.verifySignedMessage(message))) continue;
        this.remember(message.id);
        const local = signedToLocal(message);
        await saveLocalMessage(local);
        this.emitMessage(local);
      }
      return;
    }
    if (envelope.type === "chat.history.complete" && this.historyRequests.get(remotePeerId) === envelope.requestId) {
      this.historyRequests.delete(remotePeerId);
    }
  }

  private async requestHistory(remotePeerId: string): Promise<void> {
    if (!this.identity || !this.channelId || !this.transport || this.historyRequests.has(remotePeerId)) return;
    const knownIds = (await loadLocalMessages(this.channelId)).slice(-MAX_HISTORY_IDS).map((message) => message.id);
    const requestId = crypto.randomUUID();
    const request: HistoryRequestWireMessage = {
      version: 2,
      type: "chat.history.request",
      channelId: this.channelId,
      requestId,
      knownIds,
    };
    this.historyRequests.set(remotePeerId, requestId);
    if (this.transport.sendData(JSON.stringify(request), remotePeerId) === 0) this.historyRequests.delete(remotePeerId);
  }

  private async respondHistory(remotePeerId: string, request: HistoryRequestWireMessage): Promise<void> {
    if (!this.channelId || !this.transport) return;
    const known = new Set(request.knownIds);
    const messages = (await loadLocalMessages(this.channelId))
      .map(localToSignedWire)
      .filter((message): message is SignedChatWireMessage => Boolean(message) && !known.has(message!.id))
      .slice(-MAX_HISTORY_IDS);

    for (let index = 0; index < messages.length; index += HISTORY_CHUNK_MESSAGES) {
      const chunk: HistoryChunkWireMessage = {
        version: 2,
        type: "chat.history.chunk",
        channelId: this.channelId,
        requestId: request.requestId,
        messages: messages.slice(index, index + HISTORY_CHUNK_MESSAGES),
      };
      if (this.transport.sendData(JSON.stringify(chunk), remotePeerId) === 0) return;
    }
    const complete: HistoryCompleteWireMessage = {
      version: 2,
      type: "chat.history.complete",
      channelId: this.channelId,
      requestId: request.requestId,
    };
    this.transport.sendData(JSON.stringify(complete), remotePeerId);
  }

  private async signMessage(message: Omit<SignedChatWireMessage, "signature">): Promise<string> {
    if (!this.identity) throw new Error("Identidade P2P indisponível para assinar a mensagem.");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.identity.privateKey,
      new TextEncoder().encode(canonicalSignedMessage(message)),
    );
    return bytesToBase64Url(new Uint8Array(signature));
  }

  private async verifySignedMessage(message: SignedChatWireMessage): Promise<boolean> {
    const peer = this.trustedPeers.get(message.authorPeerId);
    if (!peer) return false;
    try {
      let key = this.verifyKeys.get(peer.peerId);
      if (!key) {
        key = crypto.subtle.importKey(
          "jwk",
          peer.publicKey,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        this.verifyKeys.set(peer.peerId, key);
      }
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        await key,
        base64UrlToBytes(message.signature),
        new TextEncoder().encode(canonicalSignedMessage(message)),
      );
    } catch {
      return false;
    }
  }

  private remember(messageId: string): void {
    this.processed.add(messageId);
    while (this.processed.size > 2_048) this.processed.delete(this.processed.values().next().value!);
  }

  private emitMessage(message: LocalChatMessage): void { this.messageCallbacks.forEach((callback) => callback(message)); }
  private setStatus(status: ChatConnectionStatus): void { if (this.status === status) return; this.status = status; this.statusCallbacks.forEach((callback) => callback(status)); }
}

export function parseChatWireMessage(raw: string, channelId?: string): ChatWireMessage | null {
  const envelope = parseChatWireEnvelope(raw, channelId);
  return envelope?.type === "chat.message" ? envelope : null;
}

export async function privateConversationId(peerA: string, peerB: string): Promise<string> {
  if (!validWireId(peerA) || !validWireId(peerB) || peerA === peerB) throw new Error("Peers inválidos para conversa privada.");
  const pair = [peerA, peerB].sort().join(":");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`risk-dm-v1:${pair}`));
  return `dm-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function parseChatWireEnvelope(raw: string, channelId?: string): ChatWireEnvelope | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_WIRE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.channelId !== channelId) return null;

  if (message.type === "chat.message") {
    if (message.version === 1) return parseLegacyMessage(message, channelId);
    if (message.version === 2) return parseSignedMessageObject(message, channelId, false);
    return null;
  }

  if (message.version !== 2 || !validWireId(message.requestId)) return null;
  const requestId = message.requestId as string;
  if (message.type === "chat.history.request") {
    if (!Array.isArray(message.knownIds) || message.knownIds.length > MAX_HISTORY_IDS || !message.knownIds.every(validWireId)) return null;
    return { version: 2, type: "chat.history.request", channelId: channelId!, requestId, knownIds: [...new Set(message.knownIds as string[])] };
  }
  if (message.type === "chat.history.chunk") {
    if (!Array.isArray(message.messages) || message.messages.length > HISTORY_CHUNK_MESSAGES) return null;
    const messages = message.messages.map((item) => parseSignedMessageObject(item, channelId, true));
    if (messages.some((item) => !item)) return null;
    return { version: 2, type: "chat.history.chunk", channelId: channelId!, requestId, messages: messages as SignedChatWireMessage[] };
  }
  if (message.type === "chat.history.complete") {
    return { version: 2, type: "chat.history.complete", channelId: channelId!, requestId };
  }
  return null;
}

function parseLegacyMessage(message: Record<string, unknown>, channelId?: string): LegacyChatWireMessage | null {
  const now = Date.now();
  return message.version === 1 && message.type === "chat.message" && message.channelId === channelId
    && typeof message.id === "string" && /^[0-9a-f-]{36}$/i.test(message.id)
    && typeof message.author === "string" && message.author.trim().length >= 2 && message.author.length <= 80
    && typeof message.content === "string" && message.content.trim().length > 0 && message.content.length <= 4_000
    && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    && message.timestamp >= now - LIVE_MESSAGE_MAX_AGE_MS && message.timestamp <= now + FUTURE_CLOCK_SKEW_MS
    ? message as unknown as LegacyChatWireMessage : null;
}

function parseSignedMessageObject(value: unknown, channelId?: string, allowHistorical = false): SignedChatWireMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  const now = Date.now();
  const timestampValid = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    && message.timestamp > 0 && message.timestamp <= now + FUTURE_CLOCK_SKEW_MS
    && (allowHistorical || message.timestamp >= now - LIVE_MESSAGE_MAX_AGE_MS);
  return message.version === 2 && message.type === "chat.message" && message.channelId === channelId
    && validWireId(message.id) && validWireId(message.authorPeerId)
    && typeof message.author === "string" && message.author.trim().length >= 2 && message.author.length <= 80
    && typeof message.content === "string" && message.content.trim().length > 0 && message.content.length <= 4_000
    && typeof message.signature === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(message.signature)
    && timestampValid
    ? message as unknown as SignedChatWireMessage : null;
}

function canonicalSignedMessage(message: Omit<SignedChatWireMessage, "signature"> | SignedChatWireMessage): string {
  return JSON.stringify({
    version: 2,
    type: "chat.message",
    channelId: message.channelId,
    id: message.id,
    authorPeerId: message.authorPeerId,
    author: message.author,
    content: message.content,
    timestamp: message.timestamp,
  });
}

function legacyToLocal(message: LegacyChatWireMessage, author: string): LocalChatMessage {
  return { id: message.id, channelId: message.channelId, author, content: message.content, createdAt: new Date(message.timestamp).toISOString() };
}

function signedToLocal(message: SignedChatWireMessage): LocalChatMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    author: message.author,
    content: message.content,
    createdAt: new Date(message.timestamp).toISOString(),
    authorPeerId: message.authorPeerId,
    signature: message.signature,
  };
}

function localToSignedWire(message: LocalChatMessage): SignedChatWireMessage | null {
  const timestamp = Date.parse(message.createdAt);
  if (!message.authorPeerId || !message.signature || !Number.isFinite(timestamp)) return null;
  return {
    version: 2,
    type: "chat.message",
    channelId: message.channelId,
    id: message.id,
    authorPeerId: message.authorPeerId,
    author: message.author,
    content: message.content,
    timestamp,
    signature: message.signature,
  };
}

function validWireId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
