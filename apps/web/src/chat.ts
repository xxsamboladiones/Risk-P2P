import { MeshWebRTCTransport } from "@risk/rtc";
import { SupabaseSignalingProvider } from "./services/supabase/signaling";
import type { SignalingNamespace, SignalingProvider } from "./services/signaling/types";
import { loadLocalMessages, saveLocalMessage, type LocalChatMessage } from "./services/offline/chat-storage";
import {
  getOrCreateLocalIdentity,
  loadLocalGroups,
  mergeLocalGroupMembers,
  type LocalIdentity,
  type PublicPeerIdentity,
} from "./services/offline/social-storage";

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

type IdentityChallengeWireMessage = {
  version: 2;
  type: "chat.identity.challenge";
  channelId: string;
  fromPeerId: string;
  nonce: string;
  timestamp: number;
};

type IdentityProofWireMessage = {
  version: 2;
  type: "chat.identity.proof";
  channelId: string;
  fromPeerId: string;
  toPeerId: string;
  nonce: string;
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

type GroupMembersWireMessage = {
  version: 2;
  type: "chat.members.snapshot";
  channelId: string;
  groupId: string;
  senderPeerId: string;
  members: PublicPeerIdentity[];
  timestamp: number;
  signature: string;
};

type ChatWireMessage = LegacyChatWireMessage | SignedChatWireMessage;
type ChatWireEnvelope =
  | ChatWireMessage
  | IdentityChallengeWireMessage
  | IdentityProofWireMessage
  | HistoryRequestWireMessage
  | HistoryChunkWireMessage
  | HistoryCompleteWireMessage
  | GroupMembersWireMessage;

const MAX_WIRE_BYTES = 64 * 1024;
const MAX_HISTORY_IDS = 200;
const HISTORY_CHUNK_MESSAGES = 8;
const MAX_GROUP_SYNC_MEMBERS = 128;
const LIVE_MESSAGE_MAX_AGE_MS = 120_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;

export class ChatController {
  private signaling?: SignalingProvider;
  private transport?: MeshWebRTCTransport;
  private channelId?: string;
  private groupId?: string;
  private peerId?: string;
  private displayName = "Participante";
  private identity?: LocalIdentity;
  private status: ChatConnectionStatus = "disconnected";
  private readonly processed = new Set<string>();
  private readonly dataChannelPeers = new Set<string>();
  private readonly openDataPeers = new Set<string>();
  private readonly peerNames = new Map<string, string>();
  private readonly trustedPeers = new Map<string, PublicPeerIdentity>();
  private readonly verifyKeys = new Map<string, Promise<CryptoKey>>();
  private readonly pendingIdentityChallenges = new Map<string, string>();
  private readonly historyRequests = new Map<string, string>();
  private readonly messageCallbacks = new Set<(message: LocalChatMessage) => void>();
  private readonly statusCallbacks = new Set<(status: ChatConnectionStatus) => void>();
  private unsubscribers: Array<() => void> = [];
  private refreshingMembers?: Promise<void>;

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

    const inferred = options.identity ? null : await inferLocalGroupSecurity(channelId, displayName);
    const identity = options.identity ?? inferred?.identity;
    const trustedPeers = options.trustedPeers ?? inferred?.trustedPeers ?? [];

    this.channelId = channelId;
    this.groupId = inferred?.groupId;
    this.identity = identity;
    this.peerId = identity?.peerId ?? crypto.randomUUID();
    this.displayName = displayName.trim();
    this.trustedPeers.clear();
    this.verifyKeys.clear();
    for (const peer of trustedPeers) this.trustedPeers.set(peer.peerId, peer);
    if (identity) {
      this.trustedPeers.set(identity.peerId, {
        peerId: identity.peerId,
        publicKey: identity.publicKey,
        displayName: identity.displayName,
        avatar: identity.avatar,
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
        if (state === "failed" || state === "closed") this.forgetPeerConnection(remotePeerId);
      },
      onDataMessage: (remotePeerId, data) => { void this.receive(remotePeerId, data); },
      onDataState: (remotePeerId, state) => {
        if (state === "open") {
          this.dataChannelPeers.add(remotePeerId);
          if (this.identity) void this.beginIdentityHandshake(remotePeerId);
          else this.markPeerReady(remotePeerId);
        } else {
          this.forgetPeerConnection(remotePeerId);
        }
      },
    }, options.maxRemotePeers);
    this.bindSignaling(this.signaling, this.peerId);
    if (this.groupId && typeof window !== "undefined") {
      const refresh = () => { void this.refreshGroupMembership(true); };
      window.addEventListener("risk:social-updated", refresh);
      this.unsubscribers.push(() => window.removeEventListener("risk:social-updated", refresh));
    }
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
    this.groupId = undefined;
    this.peerId = undefined;
    this.identity = undefined;
    this.refreshingMembers = undefined;
    this.dataChannelPeers.clear();
    this.openDataPeers.clear();
    this.peerNames.clear();
    this.trustedPeers.clear();
    this.verifyKeys.clear();
    this.pendingIdentityChallenges.clear();
    this.historyRequests.clear();
    this.processed.clear();
    this.setStatus("disconnected");
  }

  async send(content: string): Promise<LocalChatMessage> {
    if (!this.channelId || !this.transport) throw new Error("Conecte o chat primeiro.");
    if (this.openDataPeers.size === 0) throw new Error("Aguardando outro participante autenticar o chat P2P.");
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
      const wire: SignedChatWireMessage = { ...unsigned, signature: await this.signCanonical(canonicalSignedMessage(unsigned)) };
      if (this.sendToAuthenticatedPeers(JSON.stringify(wire)) === 0) {
        throw new Error("Nenhuma conexão P2P autenticada disponível ou os canais estão congestionados.");
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
        if (!this.isTrustedRemote(peer.peerId)) {
          if (this.groupId) {
            void this.refreshGroupMembership(true).then(() => {
              if (this.isTrustedRemote(peer.peerId)) void this.connectTrustedPeer(peer.peerId, peerId);
            });
          }
          return;
        }
        void this.connectTrustedPeer(peer.peerId, peerId);
      }),
      signaling.onPeerLeft((remotePeerId) => {
        if (!this.isTrustedRemote(remotePeerId)) return;
        this.forgetPeerConnection(remotePeerId);
        if (!this.identity) this.peerNames.delete(remotePeerId);
        void this.transport?.disconnect(remotePeerId);
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

  private async connectTrustedPeer(remotePeerId: string, localPeerId = this.peerId): Promise<void> {
    if (!localPeerId || !this.transport || !this.isTrustedRemote(remotePeerId)) return;
    await this.transport.connect(remotePeerId, localPeerId < remotePeerId).catch(() => {
      this.setStatus(this.openDataPeers.size ? "ready" : "connected");
    });
    await this.signaling?.sendPeerProfile(this.displayName).catch(() => undefined);
  }

  private isTrustedRemote(remotePeerId: string): boolean {
    if (!this.identity) return remotePeerId !== this.peerId;
    return remotePeerId !== this.identity.peerId && this.trustedPeers.has(remotePeerId);
  }

  private forgetPeerConnection(remotePeerId: string): void {
    this.dataChannelPeers.delete(remotePeerId);
    this.openDataPeers.delete(remotePeerId);
    this.pendingIdentityChallenges.delete(remotePeerId);
    this.historyRequests.delete(remotePeerId);
    this.setStatus(this.openDataPeers.size > 0 ? "ready" : this.dataChannelPeers.size > 0 ? "connected" : "connected");
  }

  private async beginIdentityHandshake(remotePeerId: string): Promise<void> {
    if (!this.identity || !this.channelId || !this.transport || !this.dataChannelPeers.has(remotePeerId) || !this.isTrustedRemote(remotePeerId)) return;
    const nonce = crypto.randomUUID();
    const challenge: IdentityChallengeWireMessage = {
      version: 2,
      type: "chat.identity.challenge",
      channelId: this.channelId,
      fromPeerId: this.identity.peerId,
      nonce,
      timestamp: Date.now(),
    };
    this.pendingIdentityChallenges.set(remotePeerId, nonce);
    if (this.transport.sendData(JSON.stringify(challenge), remotePeerId) === 0) {
      this.pendingIdentityChallenges.delete(remotePeerId);
    }
  }

  private async respondIdentityChallenge(remotePeerId: string, challenge: IdentityChallengeWireMessage): Promise<void> {
    if (!this.identity || !this.channelId || !this.transport || challenge.fromPeerId !== remotePeerId) return;
    const unsigned: Omit<IdentityProofWireMessage, "signature"> = {
      version: 2,
      type: "chat.identity.proof",
      channelId: this.channelId,
      fromPeerId: this.identity.peerId,
      toPeerId: remotePeerId,
      nonce: challenge.nonce,
      timestamp: Date.now(),
    };
    const proof: IdentityProofWireMessage = {
      ...unsigned,
      signature: await this.signCanonical(canonicalIdentityProof(unsigned)),
    };
    this.transport.sendData(JSON.stringify(proof), remotePeerId);
  }

  private async acceptIdentityProof(remotePeerId: string, proof: IdentityProofWireMessage): Promise<void> {
    if (!this.identity || proof.fromPeerId !== remotePeerId || proof.toPeerId !== this.identity.peerId) return;
    const expectedNonce = this.pendingIdentityChallenges.get(remotePeerId);
    if (!expectedNonce || proof.nonce !== expectedNonce) return;
    if (!(await this.verifyCanonical(remotePeerId, proof.signature, canonicalIdentityProof(proof)))) return;
    this.pendingIdentityChallenges.delete(remotePeerId);
    this.markPeerReady(remotePeerId);
  }

  private markPeerReady(remotePeerId: string): void {
    if (!this.dataChannelPeers.has(remotePeerId) || this.openDataPeers.has(remotePeerId)) return;
    this.openDataPeers.add(remotePeerId);
    this.setStatus("ready");
    void (async () => {
      await this.sendGroupMembership(remotePeerId);
      await this.requestHistory(remotePeerId);
    })();
  }

  private async receive(remotePeerId: string, raw: string): Promise<void> {
    if (!this.isTrustedRemote(remotePeerId)) return;
    const envelope = parseChatWireEnvelope(raw, this.channelId);
    if (!envelope) return;

    if (envelope.type === "chat.identity.challenge") {
      if (!this.identity) return;
      await this.respondIdentityChallenge(remotePeerId, envelope);
      return;
    }
    if (envelope.type === "chat.identity.proof") {
      if (!this.identity) return;
      await this.acceptIdentityProof(remotePeerId, envelope);
      return;
    }
    if (this.identity && !this.openDataPeers.has(remotePeerId)) return;

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
    if (envelope.type === "chat.members.snapshot") {
      if (!this.groupId || envelope.groupId !== this.groupId || envelope.senderPeerId !== remotePeerId) return;
      if (!(await this.verifyGroupMembership(envelope))) return;
      const merged = await mergeLocalGroupMembers(this.groupId, envelope.members);
      this.installTrustedPeers(merged.members);
      await this.connectPresentTrustedPeers();
      return;
    }
    if (envelope.type === "chat.history.request") {
      await this.sendGroupMembership(remotePeerId);
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
    if (!this.identity || !this.channelId || !this.transport || !this.openDataPeers.has(remotePeerId) || this.historyRequests.has(remotePeerId)) return;
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
    if (!this.channelId || !this.transport || !this.openDataPeers.has(remotePeerId)) return;
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

  private async refreshGroupMembership(broadcast: boolean): Promise<void> {
    if (!this.groupId || !this.identity) return;
    if (this.refreshingMembers) return this.refreshingMembers;
    this.refreshingMembers = (async () => {
      const group = (await loadLocalGroups()).find((item) => item.groupId === this.groupId);
      if (!group) return;
      this.installTrustedPeers(group.members);
      await this.connectPresentTrustedPeers();
      if (broadcast) await Promise.all([...this.openDataPeers].map((peerId) => this.sendGroupMembership(peerId)));
    })().finally(() => { this.refreshingMembers = undefined; });
    return this.refreshingMembers;
  }

  private installTrustedPeers(peers: PublicPeerIdentity[]): void {
    for (const peer of peers) {
      const current = this.trustedPeers.get(peer.peerId);
      if (current && !samePeerPublicKey(current, peer)) continue;
      this.trustedPeers.set(peer.peerId, peer);
      this.peerNames.set(peer.peerId, peer.displayName);
    }
  }

  private async connectPresentTrustedPeers(): Promise<void> {
    if (!this.signaling || !this.peerId) return;
    const present = this.signaling.getDiagnostics().presencePeers;
    await Promise.all(present.filter((peerId) => this.isTrustedRemote(peerId)).map((peerId) => this.connectTrustedPeer(peerId, this.peerId)));
  }

  private async sendGroupMembership(remotePeerId: string): Promise<void> {
    if (!this.groupId || !this.identity || !this.channelId || !this.transport || !this.openDataPeers.has(remotePeerId)) return;
    const group = (await loadLocalGroups()).find((item) => item.groupId === this.groupId);
    if (!group) return;
    const members = group.members.slice(0, MAX_GROUP_SYNC_MEMBERS);
    const unsigned: Omit<GroupMembersWireMessage, "signature"> = {
      version: 2,
      type: "chat.members.snapshot",
      channelId: this.channelId,
      groupId: this.groupId,
      senderPeerId: this.identity.peerId,
      members,
      timestamp: Date.now(),
    };
    const message: GroupMembersWireMessage = {
      ...unsigned,
      signature: await this.signCanonical(canonicalGroupMembership(unsigned)),
    };
    this.transport.sendData(JSON.stringify(message), remotePeerId);
  }

  private sendToAuthenticatedPeers(data: string): number {
    if (!this.transport) return 0;
    let sent = 0;
    for (const peerId of this.openDataPeers) sent += this.transport.sendData(data, peerId);
    return sent;
  }

  private async signCanonical(value: string): Promise<string> {
    if (!this.identity) throw new Error("Identidade P2P indisponível para assinar dados.");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.identity.privateKey,
      new TextEncoder().encode(value),
    );
    return bytesToBase64Url(new Uint8Array(signature));
  }

  private async verifySignedMessage(message: SignedChatWireMessage): Promise<boolean> {
    return this.verifyCanonical(message.authorPeerId, message.signature, canonicalSignedMessage(message));
  }

  private async verifyGroupMembership(message: GroupMembersWireMessage): Promise<boolean> {
    return this.verifyCanonical(message.senderPeerId, message.signature, canonicalGroupMembership(message));
  }

  private async verifyCanonical(peerId: string, signature: string, canonical: string): Promise<boolean> {
    const peer = this.trustedPeers.get(peerId);
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
        base64UrlToArrayBuffer(signature),
        new TextEncoder().encode(canonical),
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

async function inferLocalGroupSecurity(
  channelId: string,
  displayName: string,
): Promise<{ groupId: string; identity: LocalIdentity; trustedPeers: PublicPeerIdentity[] } | null> {
  const group = (await loadLocalGroups()).find((item) => item.channels.some((channel) => channel.kind === "text" && channel.id === channelId));
  if (!group) return null;
  return {
    groupId: group.groupId,
    identity: await getOrCreateLocalIdentity(displayName),
    trustedPeers: group.members,
  };
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
  if (message.version === 2 && message.type === "chat.identity.challenge") return parseIdentityChallenge(message, channelId);
  if (message.version === 2 && message.type === "chat.identity.proof") return parseIdentityProof(message, channelId);
  if (message.version === 2 && message.type === "chat.members.snapshot") return parseGroupMembership(message, channelId);

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

function parseIdentityChallenge(message: Record<string, unknown>, channelId?: string): IdentityChallengeWireMessage | null {
  if (!validWireId(message.fromPeerId) || !validWireId(message.nonce) || !freshTimestamp(message.timestamp)) return null;
  return {
    version: 2,
    type: "chat.identity.challenge",
    channelId: channelId!,
    fromPeerId: message.fromPeerId,
    nonce: message.nonce,
    timestamp: message.timestamp,
  } as IdentityChallengeWireMessage;
}

function parseIdentityProof(message: Record<string, unknown>, channelId?: string): IdentityProofWireMessage | null {
  if (!validWireId(message.fromPeerId) || !validWireId(message.toPeerId) || !validWireId(message.nonce) || !freshTimestamp(message.timestamp)) return null;
  if (typeof message.signature !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(message.signature)) return null;
  return {
    version: 2,
    type: "chat.identity.proof",
    channelId: channelId!,
    fromPeerId: message.fromPeerId,
    toPeerId: message.toPeerId,
    nonce: message.nonce,
    timestamp: message.timestamp,
    signature: message.signature,
  } as IdentityProofWireMessage;
}

function parseGroupMembership(message: Record<string, unknown>, channelId?: string): GroupMembersWireMessage | null {
  if (!validWireId(message.groupId) || !validWireId(message.senderPeerId)) return null;
  if (!Array.isArray(message.members) || message.members.length === 0 || message.members.length > MAX_GROUP_SYNC_MEMBERS) return null;
  if (!message.members.every(isPublicPeerIdentity) || !freshTimestamp(message.timestamp)) return null;
  if (typeof message.signature !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(message.signature)) return null;
  return {
    version: 2,
    type: "chat.members.snapshot",
    channelId: channelId!,
    groupId: message.groupId,
    senderPeerId: message.senderPeerId,
    members: message.members,
    timestamp: message.timestamp,
    signature: message.signature,
  } as GroupMembersWireMessage;
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

function canonicalIdentityProof(message: Omit<IdentityProofWireMessage, "signature"> | IdentityProofWireMessage): string {
  return JSON.stringify({
    version: 2,
    type: "chat.identity.proof",
    channelId: message.channelId,
    fromPeerId: message.fromPeerId,
    toPeerId: message.toPeerId,
    nonce: message.nonce,
    timestamp: message.timestamp,
  });
}

function canonicalGroupMembership(message: Omit<GroupMembersWireMessage, "signature"> | GroupMembersWireMessage): string {
  return JSON.stringify({
    version: 2,
    type: "chat.members.snapshot",
    channelId: message.channelId,
    groupId: message.groupId,
    senderPeerId: message.senderPeerId,
    members: [...message.members]
      .sort((left, right) => left.peerId.localeCompare(right.peerId))
      .map((member) => ({
        peerId: member.peerId,
        displayName: member.displayName,
        avatar: member.avatar ?? null,
        publicKey: {
          kty: member.publicKey.kty ?? null,
          crv: member.publicKey.crv ?? null,
          x: member.publicKey.x ?? null,
          y: member.publicKey.y ?? null,
        },
      })),
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

function isPublicPeerIdentity(value: unknown): value is PublicPeerIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  if (!validWireId(identity.peerId)) return false;
  if (typeof identity.displayName !== "string" || identity.displayName.trim().length < 2 || identity.displayName.length > 80) return false;
  if (!identity.publicKey || typeof identity.publicKey !== "object") return false;
  const key = identity.publicKey as JsonWebKey;
  return key.kty === "EC" && key.crv === "P-256" && typeof key.x === "string" && typeof key.y === "string";
}

function samePeerPublicKey(left: PublicPeerIdentity, right: PublicPeerIdentity): boolean {
  return left.publicKey.kty === right.publicKey.kty
    && left.publicKey.crv === right.publicKey.crv
    && left.publicKey.x === right.publicKey.x
    && left.publicKey.y === right.publicKey.y;
}

function freshTimestamp(value: unknown): value is number {
  const now = Date.now();
  return typeof value === "number" && Number.isFinite(value)
    && value >= now - LIVE_MESSAGE_MAX_AGE_MS
    && value <= now + FUTURE_CLOCK_SKEW_MS;
}

function validWireId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}
