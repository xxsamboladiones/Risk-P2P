import { MeshWebRTCTransport } from "@risk/rtc";
import { AttachmentService, type AttachmentRuntimeState } from "./services/attachments/attachment-service";
import { createAttachmentStorage } from "./services/attachments/desktop-storage";
import type { StoredAttachmentRecord } from "./services/attachments/indexeddb-storage";
import { SupabaseSignalingProvider } from "./services/supabase/signaling";
import type { SignalingNamespace, SignalingProvider } from "./services/signaling/types";
import {
  compatibleAppVersion,
  compatibleChatPeer,
  incompatiblePeerMessage,
  LOCAL_RISK_CAPABILITIES,
  validRiskPeerCapabilities,
  type RiskPeerCapabilities,
} from "./services/protocol-compatibility";
import { loadLocalMessages, saveLocalMessage, type LocalChatMessage, type MessagePageOptions } from "./services/offline/chat-storage";
import { enqueueOutbox, loadOutbox, markOutboxAttempt, removeOutbox } from "./services/offline/outbox-storage";
import { validAvatarDataUrl } from "./services/offline/profile";
import {
  applyGroupRevocationCertificate,
  getOrCreateLocalIdentity,
  loadLocalGroups,
  mergeLocalGroupManifest,
  updateKnownPeerProfile,
  validGroupAdministratorGrant,
  validGroupRevocationCertificate,
  groupRendezvousId,
  type GroupAdministratorGrant,
  type GroupRevocationCertificate,
  type LocalGroupChannel,
  type LocalIdentity,
  type PublicPeerIdentity,
} from "./services/offline/social-storage";

export type ChatConnectionStatus = "disconnected" | "connecting" | "connected" | "ready" | "incompatible" | "error";
export type ChatAttachmentRecord = StoredAttachmentRecord;
export type ChatAttachmentProgress = AttachmentRuntimeState;

export type ChatConnectionOptions = {
  identity?: LocalIdentity;
  trustedPeers?: PublicPeerIdentity[];
  revokedPeers?: PublicPeerIdentity[];
  revocations?: GroupRevocationCertificate[];
  groupId?: string;
  requireIdentityAuthentication?: boolean;
  rendezvousId?: string;
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
  capabilities: RiskPeerCapabilities;
};

type IdentityProofWireMessage = {
  version: 2;
  type: "chat.identity.proof";
  channelId: string;
  fromPeerId: string;
  toPeerId: string;
  nonce: string;
  timestamp: number;
  capabilities: RiskPeerCapabilities;
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
  ownerPeerId: string;
  membershipVersion: number;
  manifestVersion: number;
  manifestActorPeerId: string;
  manifestOperationId: string;
  administratorEpoch: number;
  administratorGrants: GroupAdministratorGrant[];
  name: string;
  avatar?: string;
  channels: LocalGroupChannel[];
  administratorPeerIds: string[];
  removedPeerIds: string[];
  removedMembers: PublicPeerIdentity[];
  revocations: GroupRevocationCertificate[];
  rendezvousVersion: number;
  rendezvousSecret: string;
  members: PublicPeerIdentity[];
  timestamp: number;
  signature: string;
};

type MessageAckWireMessage = { version: 2; type: "chat.message.ack"; channelId: string; messageId: string };
type GroupRevocationWireMessage = { version: 2; type: "chat.group.revocation"; channelId: string; certificate: GroupRevocationCertificate };

type ProfileUpdateWireMessage = {
  version: 2;
  type: "chat.profile.update";
  channelId: string;
  identity: PublicPeerIdentity;
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
  | GroupMembersWireMessage
  | ProfileUpdateWireMessage
  | GroupRevocationWireMessage
  | MessageAckWireMessage;

const MAX_WIRE_BYTES = 64 * 1024;
const MAX_HISTORY_IDS = 200;
const HISTORY_CHUNK_MESSAGES = 8;
const MAX_GROUP_SYNC_MEMBERS = 48;
const MAX_GROUP_SYNC_REVOCATIONS = 48;
const LIVE_MESSAGE_MAX_AGE_MS = 120_000;
const QUEUED_MESSAGE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;
const IDENTITY_HANDSHAKE_RETRY_MS = 1_200;
const IDENTITY_HANDSHAKE_TIMEOUT_MS = 12_000;
const CHAT_READY_TIMEOUT_MS = 15_000;

export class ChatController {
  private signaling?: SignalingProvider;
  private transport?: MeshWebRTCTransport;
  private attachmentService?: AttachmentService;
  private channelId?: string;
  private groupId?: string;
  private rendezvousId?: string;
  private signalingNamespace: SignalingNamespace = "chat";
  private peerId?: string;
  private displayName = "Participante";
  private identity?: LocalIdentity;
  private status: ChatConnectionStatus = "disconnected";
  private readonly processed = new Set<string>();
  private readonly dataChannelPeers = new Set<string>();
  private readonly openDataPeers = new Set<string>();
  private readonly revocationOnlyPeers = new Set<string>();
  private readonly peerNames = new Map<string, string>();
  private readonly trustedPeers = new Map<string, PublicPeerIdentity>();
  private readonly revokedPeers = new Map<string, PublicPeerIdentity>();
  private revocations: GroupRevocationCertificate[] = [];
  private readonly verifyKeys = new Map<string, Promise<CryptoKey>>();
  private readonly pendingIdentityChallenges = new Map<string, string>();
  private readonly identityHandshakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly identityHandshakeStartedAt = new Map<string, number>();
  private readonly identityHandshakeFailedPeers = new Set<string>();
  private readonly historyRequests = new Map<string, string>();
  private readonly messageCallbacks = new Set<(message: LocalChatMessage) => void>();
  private readonly statusCallbacks = new Set<(status: ChatConnectionStatus) => void>();
  private readonly attachmentCallbacks = new Set<(record: StoredAttachmentRecord) => void>();
  private readonly attachmentProgressCallbacks = new Set<(progress: AttachmentRuntimeState) => void>();
  private unsubscribers: Array<() => void> = [];
  private refreshingMembers?: Promise<void>;
  private sessionToken?: object;
  private readyTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly createSignaling: () => SignalingProvider = () => new SupabaseSignalingProvider()) {}

  history(channelId: string, options?: MessagePageOptions): Promise<LocalChatMessage[]> { return loadLocalMessages(channelId, options); }

  async attachmentHistory(channelId: string): Promise<StoredAttachmentRecord[]> {
    if (this.attachmentService && this.channelId === channelId) return this.attachmentService.history();
    return (await createAttachmentStorage()).listChannel(channelId);
  }

  async connect(
    channelId: string,
    displayName: string,
    iceServers: RTCIceServer[],
    options: ChatConnectionOptions = {},
  ): Promise<void> {
    await this.disconnect();
    this.setStatus("connecting");
    const sessionToken = {};
    this.sessionToken = sessionToken;
    let signaling: SignalingProvider | undefined;
    let transport: MeshWebRTCTransport | undefined;

    try {
      const inferred = options.identity ? null : await inferLocalGroupSecurity(channelId, displayName);
      if (this.sessionToken !== sessionToken) throw new DOMException("Conexão do chat substituída por outra sessão.", "AbortError");
      const identity = options.identity ?? inferred?.identity;
      const trustedPeers = options.trustedPeers ?? inferred?.trustedPeers ?? [];
      const revokedPeers = options.revokedPeers ?? inferred?.revokedPeers ?? [];
      if (options.requireIdentityAuthentication && !identity) {
        throw new Error("A identidade P2P é obrigatória para conectar ao chat deste grupo.");
      }

      const localPeerId = identity?.peerId ?? crypto.randomUUID();
      const rendezvousId = options.rendezvousId ?? inferred?.rendezvousId ?? channelId;
      const namespace = options.namespace ?? "chat";
      this.channelId = channelId;
      this.groupId = options.groupId ?? inferred?.groupId;
      this.rendezvousId = rendezvousId;
      this.signalingNamespace = namespace;
      this.identity = identity;
      this.peerId = localPeerId;
      this.displayName = displayName.trim();
      this.trustedPeers.clear();
      this.revokedPeers.clear();
      this.revocations = options.revocations ?? inferred?.revocations ?? [];
      this.verifyKeys.clear();
      for (const peer of trustedPeers) this.trustedPeers.set(peer.peerId, peer);
      for (const peer of revokedPeers) this.revokedPeers.set(peer.peerId, peer);
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

      signaling = this.createSignaling();
      this.signaling = signaling;
      transport = new MeshWebRTCTransport(localPeerId, iceServers, {
        sendOffer: (targetPeerId, description) => signaling!.sendOffer(targetPeerId, description),
        sendAnswer: (targetPeerId, description) => signaling!.sendAnswer(targetPeerId, description),
        sendIce: (targetPeerId, candidate) => signaling!.sendIceCandidate(targetPeerId, candidate),
        onRemoteStream: () => undefined,
        onConnectionState: (remotePeerId, state) => {
          if (this.sessionToken !== sessionToken) return;
          if (state === "failed" || state === "closed") this.forgetPeerConnection(remotePeerId);
        },
        onNegotiationError: (remotePeerId, error) => {
          if (this.sessionToken !== sessionToken) return;
          console.warn("Falha de negociação WebRTC no chat", { remotePeerId, error });
          if (this.openDataPeers.size === 0) this.setStatus("error");
        },
        onDataMessage: (remotePeerId, data) => {
          if (this.sessionToken !== sessionToken) return;
          void this.receiveData(remotePeerId, data);
        },
        onDataState: (remotePeerId, state) => {
          if (this.sessionToken !== sessionToken) return;
          if (state === "open") {
            this.dataChannelPeers.add(remotePeerId);
            this.identityHandshakeFailedPeers.delete(remotePeerId);
            if (this.identity) void this.beginIdentityHandshake(remotePeerId);
            else this.markPeerReady(remotePeerId);
          } else {
            this.forgetPeerConnection(remotePeerId);
          }
        },
        onTransferMessage: (remotePeerId, data) => {
          if (this.sessionToken !== sessionToken || !this.openDataPeers.has(remotePeerId)) return;
          void this.attachmentService?.handleTransferFrame(remotePeerId, data).catch((error) => console.warn("Frame de anexo rejeitado", error));
        },
        onTransferState: (remotePeerId, state) => {
          if (this.sessionToken !== sessionToken) return;
          if (state === "open" && this.openDataPeers.has(remotePeerId) && !this.revokedPeers.has(remotePeerId)) {
            void this.attachmentService?.peerReady(remotePeerId).catch((error) => console.warn("Falha ao preparar canal de anexos", { remotePeerId, error }));
          }
        },
      }, options.maxRemotePeers);
      this.transport = transport;

      const attachmentStorage = await createAttachmentStorage();
      if (this.sessionToken !== sessionToken || this.transport !== transport) {
        await transport.disconnect().catch(() => undefined);
        throw new DOMException("Conexão do chat substituída por outra sessão.", "AbortError");
      }
      this.installAttachmentService(new AttachmentService(
        transport,
        channelId,
        localPeerId,
        () => this.sessionToken === sessionToken ? [...this.openDataPeers] : [],
        attachmentStorage,
      ));
      this.bindSignaling(signaling, localPeerId);
      if (this.groupId && typeof window !== "undefined") {
        const refresh = () => { if (this.sessionToken === sessionToken) void this.refreshGroupMembership(true); };
        window.addEventListener("risk:social-updated", refresh);
        this.unsubscribers.push(() => window.removeEventListener("risk:social-updated", refresh));
      }

      await signaling.connect(rendezvousId, localPeerId, namespace);
      if (this.sessionToken !== sessionToken || this.transport !== transport) {
        throw new DOMException("Conexão do chat substituída por outra sessão.", "AbortError");
      }
      this.setStatus("connected");
      this.armReadyTimeout(sessionToken);
      if (this.groupId) await this.refreshGroupMembership(false);
      else await this.connectPresentTrustedPeers();
    } catch (error) {
      if (this.sessionToken === sessionToken) {
        await this.disconnect();
        if (!(error instanceof DOMException && error.name === "AbortError")) this.setStatus("error");
      } else {
        await signaling?.disconnect().catch(() => undefined);
        await transport?.disconnect().catch(() => undefined);
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const signaling = this.signaling;
    const transport = this.transport;
    const unsubscribers = this.unsubscribers.splice(0);

    // Desanexa o estado atual antes de aguardar rede/RTC. Assim um disconnect antigo
    // não consegue apagar um signaling/transport criado por uma conexão posterior.
    this.sessionToken = undefined;
    this.signaling = undefined;
    this.transport = undefined;
    this.attachmentService = undefined;
    this.channelId = undefined;
    this.groupId = undefined;
    this.rendezvousId = undefined;
    this.signalingNamespace = "chat";
    this.peerId = undefined;
    this.identity = undefined;
    this.refreshingMembers = undefined;
    this.clearReadyTimeout();
    this.dataChannelPeers.clear();
    this.openDataPeers.clear();
    this.revocationOnlyPeers.clear();
    this.peerNames.clear();
    this.trustedPeers.clear();
    this.revokedPeers.clear();
    this.revocations = [];
    this.verifyKeys.clear();
    this.pendingIdentityChallenges.clear();
    this.identityHandshakeStartedAt.clear();
    this.identityHandshakeFailedPeers.clear();
    this.historyRequests.clear();
    this.processed.clear();
    for (const timer of this.identityHandshakeTimers.values()) clearTimeout(timer);
    this.identityHandshakeTimers.clear();
    this.setStatus("disconnected");

    unsubscribers.forEach((unsubscribe) => unsubscribe());
    await signaling?.disconnect().catch(() => undefined);
    await transport?.disconnect().catch(() => undefined);
  }

  async send(content: string): Promise<LocalChatMessage> {
    if (!this.channelId || !this.transport) throw new Error("Conecte o chat primeiro.");
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 4_000) throw new Error("Mensagem inválida.");
    const timestamp = Date.now();

    if (this.identity) {
      const wire = await this.createSignedMessage(this.channelId, trimmed, timestamp);
      const serialized = JSON.stringify(wire);
      await enqueueOutbox(this.channelId, wire.id, serialized);
      this.sendToAuthenticatedPeers(serialized);
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

  async queue(channelId: string, content: string, displayName: string): Promise<LocalChatMessage> {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 4_000) throw new Error("Mensagem inválida.");
    const identity = await getOrCreateLocalIdentity(displayName);
    const unsigned: Omit<SignedChatWireMessage, "signature"> = {
      version: 2, type: "chat.message", channelId, id: crypto.randomUUID(), authorPeerId: identity.peerId,
      author: identity.displayName, content: trimmed, timestamp: Date.now(),
    };
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, new TextEncoder().encode(canonicalSignedMessage(unsigned)));
    const wire: SignedChatWireMessage = { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
    await enqueueOutbox(channelId, wire.id, JSON.stringify(wire));
    const local = signedToLocal(wire);
    await saveLocalMessage(local);
    this.emitMessage(local);
    return local;
  }

  async sendAttachment(file: File): Promise<void> {
    if (!this.attachmentService || this.status !== "ready") throw new Error("Conecte e autentique o chat P2P antes de enviar arquivos.");
    await this.attachmentService.sendFile(file);
  }

  async requestAttachment(record: StoredAttachmentRecord): Promise<void> {
    if (!this.attachmentService) throw new Error("Conecte o chat para solicitar este arquivo.");
    await this.attachmentService.requestDownload(record);
  }

  async downloadAttachment(record: StoredAttachmentRecord): Promise<void> {
    if (!this.attachmentService) {
      const storage = await createAttachmentStorage();
      const locallyAvailable = record.direction === "outgoing" ? record.sourcePersisted === true : record.state === "completed";
      if (!locallyAvailable) throw new Error("Conecte ao peer para baixar este arquivo.");
      const blob = await storage.getBlob(record.attachmentId, record.manifest);
      triggerDownload(blob, record.manifest.filename);
      return;
    }
    await this.attachmentService.download(record);
  }

  async attachmentBlob(record: StoredAttachmentRecord): Promise<Blob> {
    if (this.attachmentService) return this.attachmentService.getBlob(record);
    return (await createAttachmentStorage()).getBlob(record.attachmentId, record.manifest);
  }

  async pauseAttachment(record: StoredAttachmentRecord): Promise<void> { await this.attachmentService?.pause(record); }
  async resumeAttachment(record: StoredAttachmentRecord): Promise<void> { await this.attachmentService?.resume(record); }
  async cancelAttachment(record: StoredAttachmentRecord): Promise<void> { await this.attachmentService?.cancel(record); }

  onMessage(callback: (message: LocalChatMessage) => void): () => void { this.messageCallbacks.add(callback); return () => this.messageCallbacks.delete(callback); }
  onStatus(callback: (status: ChatConnectionStatus) => void): () => void { this.statusCallbacks.add(callback); return () => this.statusCallbacks.delete(callback); }
  onAttachment(callback: (record: StoredAttachmentRecord) => void): () => void { this.attachmentCallbacks.add(callback); return () => this.attachmentCallbacks.delete(callback); }
  onAttachmentProgress(callback: (progress: AttachmentRuntimeState) => void): () => void { this.attachmentProgressCallbacks.add(callback); return () => this.attachmentProgressCallbacks.delete(callback); }

  private installAttachmentService(service: AttachmentService): void {
    this.attachmentService = service;
    service.addEventListener("attachment", (event) => {
      const record = (event as CustomEvent<StoredAttachmentRecord>).detail;
      this.attachmentCallbacks.forEach((callback) => callback(record));
    });
    service.addEventListener("progress", (event) => {
      const progress = (event as CustomEvent<AttachmentRuntimeState>).detail;
      this.attachmentProgressCallbacks.forEach((callback) => callback(progress));
    });
  }

  private async receiveData(remotePeerId: string, raw: string): Promise<void> {
    if (this.identity && this.rejectIncompatibleIdentityEnvelope(remotePeerId, raw)) return;
    if (this.openDataPeers.has(remotePeerId) && this.attachmentService) {
      try {
        if (await this.attachmentService.handleControlString(remotePeerId, raw)) return;
      } catch (error) {
        console.warn("Controle de anexo/sync rejeitado", error);
        return;
      }
    }
    await this.receive(remotePeerId, raw);
  }

  private bindSignaling(signaling: SignalingProvider, peerId: string): void {
    this.unsubscribers.push(
      signaling.onPeerJoined((peer) => {
        if (this.identity && peer.clientVersion && !compatibleAppVersion(peer.clientVersion)) {
          this.rejectIncompatiblePeer(peer.peerId, peer.clientVersion);
          return;
        }
        if (!this.isTrustedRemote(peer.peerId)) {
          if (this.groupId) {
            void this.refreshGroupMembership(true).then(() => {
              if (this.isTrustedRemote(peer.peerId)) {
                void this.connectTrustedPeer(peer.peerId, peerId);
              } else if (this.openDataPeers.size === 0) {
                console.warn("Peer presente no chat não corresponde a uma identidade confiável do grupo", {
                  remotePeerId: peer.peerId,
                  localPeerId: this.peerId,
                  channelId: this.channelId,
                  trustedPeerIds: [...this.trustedPeers.keys()],
                });
              }
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
      signaling.onStatusChange((status) => {
        if (status === "connected" && this.openDataPeers.size === 0) {
          this.setStatus("connected");
          if (this.sessionToken) this.armReadyTimeout(this.sessionToken);
          void (this.groupId ? this.refreshGroupMembership(false) : this.connectPresentTrustedPeers());
        }
        if (status === "reconnecting" && this.openDataPeers.size === 0) this.setStatus("connecting");
        if (status === "error" && this.openDataPeers.size === 0) this.setStatus("error");
      }),
    );
  }

  private async connectTrustedPeer(remotePeerId: string, localPeerId = this.peerId): Promise<void> {
    if (!localPeerId || !this.transport || !this.isTrustedRemote(remotePeerId)) return;
    await this.transport.connect(remotePeerId, localPeerId < remotePeerId).catch((error) => {
      console.warn("Falha ao conectar peer confiável do chat", { remotePeerId, error });
      this.setStatus(this.openDataPeers.size ? "ready" : "connected");
      if (this.sessionToken && this.openDataPeers.size === 0) this.armReadyTimeout(this.sessionToken);
    });
  }

  private isTrustedRemote(remotePeerId: string): boolean {
    if (!this.identity) return remotePeerId !== this.peerId;
    return remotePeerId !== this.identity.peerId
      && (this.trustedPeers.has(remotePeerId) || this.revokedPeers.has(remotePeerId));
  }

  private forgetPeerConnection(remotePeerId: string): void {
    this.clearIdentityHandshake(remotePeerId);
    this.identityHandshakeFailedPeers.delete(remotePeerId);
    this.dataChannelPeers.delete(remotePeerId);
    this.openDataPeers.delete(remotePeerId);
    this.revocationOnlyPeers.delete(remotePeerId);
    this.pendingIdentityChallenges.delete(remotePeerId);
    this.historyRequests.delete(remotePeerId);
    this.attachmentService?.forgetPeer(remotePeerId);
    this.setStatus(this.openDataPeers.size > 0 ? "ready" : "connected");
    if (this.sessionToken && this.openDataPeers.size === 0) this.armReadyTimeout(this.sessionToken);
  }

  private async beginIdentityHandshake(remotePeerId: string): Promise<void> {
    if (!this.identity || !this.channelId || !this.transport || !this.dataChannelPeers.has(remotePeerId) || !this.isTrustedRemote(remotePeerId) || this.openDataPeers.has(remotePeerId) || this.identityHandshakeFailedPeers.has(remotePeerId)) return;
    const now = Date.now();
    const startedAt = this.identityHandshakeStartedAt.get(remotePeerId) ?? now;
    this.identityHandshakeStartedAt.set(remotePeerId, startedAt);
    if (now - startedAt >= IDENTITY_HANDSHAKE_TIMEOUT_MS) {
      this.failIdentityHandshake(remotePeerId, "timeout");
      return;
    }

    const nonce = this.pendingIdentityChallenges.get(remotePeerId) ?? crypto.randomUUID();
    const challenge: IdentityChallengeWireMessage = {
      version: 2,
      type: "chat.identity.challenge",
      channelId: this.channelId,
      fromPeerId: this.identity.peerId,
      nonce,
      timestamp: now,
      capabilities: LOCAL_RISK_CAPABILITIES,
    };
    this.pendingIdentityChallenges.set(remotePeerId, nonce);
    this.transport.sendData(JSON.stringify(challenge), remotePeerId);
    this.scheduleIdentityHandshake(remotePeerId);
  }

  private scheduleIdentityHandshake(remotePeerId: string): void {
    this.clearIdentityHandshakeTimer(remotePeerId);
    if (!this.identity || !this.transport || !this.dataChannelPeers.has(remotePeerId) || this.openDataPeers.has(remotePeerId) || this.identityHandshakeFailedPeers.has(remotePeerId)) return;
    const startedAt = this.identityHandshakeStartedAt.get(remotePeerId) ?? Date.now();
    this.identityHandshakeStartedAt.set(remotePeerId, startedAt);
    const remaining = IDENTITY_HANDSHAKE_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      this.failIdentityHandshake(remotePeerId, "timeout");
      return;
    }
    const timer = setTimeout(() => {
      this.identityHandshakeTimers.delete(remotePeerId);
      if (!this.dataChannelPeers.has(remotePeerId) || this.openDataPeers.has(remotePeerId)) return;
      if (Date.now() - startedAt >= IDENTITY_HANDSHAKE_TIMEOUT_MS) {
        this.failIdentityHandshake(remotePeerId, "timeout");
        return;
      }
      void this.beginIdentityHandshake(remotePeerId);
    }, Math.min(IDENTITY_HANDSHAKE_RETRY_MS, remaining));
    this.identityHandshakeTimers.set(remotePeerId, timer);
  }

  private clearIdentityHandshakeTimer(remotePeerId: string): void {
    const timer = this.identityHandshakeTimers.get(remotePeerId);
    if (timer) clearTimeout(timer);
    this.identityHandshakeTimers.delete(remotePeerId);
  }

  private clearIdentityHandshake(remotePeerId: string): void {
    this.clearIdentityHandshakeTimer(remotePeerId);
    this.identityHandshakeStartedAt.delete(remotePeerId);
  }

  private failIdentityHandshake(remotePeerId: string, reason: "timeout" | "invalid-proof"): void {
    this.clearIdentityHandshake(remotePeerId);
    this.pendingIdentityChallenges.delete(remotePeerId);
    this.identityHandshakeFailedPeers.add(remotePeerId);
    console.warn("Autenticação de identidade do chat P2P não foi concluída", {
      reason,
      remotePeerId,
      localPeerId: this.peerId,
      channelId: this.channelId,
      trustedPeer: this.trustedPeers.has(remotePeerId),
      presencePeers: this.signaling?.getDiagnostics().presencePeers ?? [],
    });
    if (this.openDataPeers.size === 0) this.setStatus("error");
  }

  private async respondIdentityChallenge(remotePeerId: string, challenge: IdentityChallengeWireMessage): Promise<void> {
    const sessionToken = this.sessionToken;
    const identity = this.identity;
    const channelId = this.channelId;
    const transport = this.transport;
    if (!sessionToken || !identity || !channelId || !transport || challenge.fromPeerId !== remotePeerId) return;
    const unsigned: Omit<IdentityProofWireMessage, "signature"> = {
      version: 2,
      type: "chat.identity.proof",
      channelId,
      fromPeerId: identity.peerId,
      toPeerId: remotePeerId,
      nonce: challenge.nonce,
      timestamp: Date.now(),
      capabilities: LOCAL_RISK_CAPABILITIES,
    };
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(canonicalIdentityProof(unsigned)),
    );
    if (this.sessionToken !== sessionToken || this.transport !== transport || !this.dataChannelPeers.has(remotePeerId)) return;
    const proof: IdentityProofWireMessage = { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
    transport.sendData(JSON.stringify(proof), remotePeerId);
    if (!this.openDataPeers.has(remotePeerId) && !this.pendingIdentityChallenges.has(remotePeerId) && !this.identityHandshakeFailedPeers.has(remotePeerId)) {
      void this.beginIdentityHandshake(remotePeerId);
    }
  }

  private async acceptIdentityProof(remotePeerId: string, proof: IdentityProofWireMessage): Promise<void> {
    const sessionToken = this.sessionToken;
    const identity = this.identity;
    if (!sessionToken || !identity || proof.fromPeerId !== remotePeerId || proof.toPeerId !== identity.peerId) return;
    const expectedNonce = this.pendingIdentityChallenges.get(remotePeerId);
    if (!expectedNonce || proof.nonce !== expectedNonce) return;
    const valid = await this.verifyCanonical(remotePeerId, proof.signature, canonicalIdentityProof(proof));
    if (this.sessionToken !== sessionToken || this.identity !== identity || this.pendingIdentityChallenges.get(remotePeerId) !== expectedNonce) return;
    if (!valid) {
      console.warn("Prova de identidade P2P inválida", { remotePeerId });
      this.failIdentityHandshake(remotePeerId, "invalid-proof");
      return;
    }
    this.pendingIdentityChallenges.delete(remotePeerId);
    this.clearIdentityHandshake(remotePeerId);
    this.identityHandshakeFailedPeers.delete(remotePeerId);
    if (this.revokedPeers.has(remotePeerId)) this.markRevokedPeerReady(remotePeerId);
    else this.markPeerReady(remotePeerId);
  }

  private rejectIncompatibleIdentityEnvelope(remotePeerId: string, raw: string): boolean {
    if (new TextEncoder().encode(raw).byteLength > MAX_WIRE_BYTES) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return false; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const message = parsed as Record<string, unknown>;
    if (message.type !== "chat.identity.challenge" && message.type !== "chat.identity.proof") return false;
    if (!validRiskPeerCapabilities(message.capabilities) || !compatibleChatPeer(message.capabilities)) {
      const version = validRiskPeerCapabilities(message.capabilities) ? message.capabilities.appVersion : undefined;
      this.rejectIncompatiblePeer(remotePeerId, version);
      return true;
    }
    return false;
  }

  private rejectIncompatiblePeer(remotePeerId: string, remoteVersion?: string): void {
    console.warn(incompatiblePeerMessage(remoteVersion), { remotePeerId });
    this.forgetPeerConnection(remotePeerId);
    if (this.openDataPeers.size === 0) {
      this.clearReadyTimeout();
      this.setStatus("incompatible");
    }
    void this.transport?.disconnect(remotePeerId);
  }

  private markRevokedPeerReady(remotePeerId: string): void {
    if (!this.dataChannelPeers.has(remotePeerId) || this.revocationOnlyPeers.has(remotePeerId)) return;
    this.openDataPeers.delete(remotePeerId);
    this.revocationOnlyPeers.add(remotePeerId);
    this.clearReadyTimeout();
    void this.sendRevocations(remotePeerId);
  }

  private markPeerReady(remotePeerId: string): void {
    if (!this.dataChannelPeers.has(remotePeerId) || this.openDataPeers.has(remotePeerId)) return;
    if (this.revokedPeers.has(remotePeerId)) {
      this.markRevokedPeerReady(remotePeerId);
      return;
    }
    const sessionToken = this.sessionToken;
    if (!sessionToken) return;
    const attachmentService = this.attachmentService;
    this.clearIdentityHandshake(remotePeerId);
    this.identityHandshakeFailedPeers.delete(remotePeerId);
    this.openDataPeers.add(remotePeerId);
    this.clearReadyTimeout();
    this.setStatus("ready");
    void (async () => {
      await this.sendProfileUpdate(remotePeerId);
      if (!this.isSessionPeerActive(sessionToken, remotePeerId)) return;
      await this.sendGroupMembership(remotePeerId);
      if (!this.isSessionPeerActive(sessionToken, remotePeerId)) return;
      await this.flushOutbox(remotePeerId);
      if (!this.isSessionPeerActive(sessionToken, remotePeerId)) return;
      await this.requestHistory(remotePeerId);
      if (!this.isSessionPeerActive(sessionToken, remotePeerId)) return;
      if (attachmentService === this.attachmentService) await attachmentService?.peerReady(remotePeerId);
    })().catch((error) => {
      if (this.sessionToken !== sessionToken) return;
      console.warn("Falha ao preparar peer autenticado do chat", { remotePeerId, error });
      if (this.openDataPeers.size === 0) this.setStatus("error");
    });
  }

  private isSessionPeerActive(sessionToken: object, remotePeerId: string): boolean {
    return this.sessionToken === sessionToken && Boolean(this.transport) && this.openDataPeers.has(remotePeerId);
  }

  private armReadyTimeout(sessionToken: object): void {
    this.clearReadyTimeout();
    if (this.openDataPeers.size > 0 || this.sessionToken !== sessionToken) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined;
      if (this.sessionToken !== sessionToken || this.openDataPeers.size > 0) return;
      const diagnostics = this.signaling?.getDiagnostics();
      console.warn("Tempo esgotado aguardando chat P2P ficar pronto", {
        channelId: this.channelId,
        localPeerId: this.peerId,
        presencePeers: diagnostics?.presencePeers ?? [],
        trustedPeerIds: [...this.trustedPeers.keys()],
        dataChannelPeers: [...this.dataChannelPeers],
        failedIdentityPeers: [...this.identityHandshakeFailedPeers],
      });
      // Estar sozinho não é uma falha: Presence e signaling permanecem ativos e
      // o chat pode ficar pronto assim que outro participante entrar. Reservamos
      // `error` para falhas reais de signaling/negociação.
      this.setStatus("connected");
    }, CHAT_READY_TIMEOUT_MS);
  }

  private clearReadyTimeout(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
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
    if (envelope.type === "chat.group.revocation") {
      if (!this.groupId || envelope.certificate.groupId !== this.groupId) return;
      if (await applyGroupRevocationCertificate(envelope.certificate)) {
        if (envelope.certificate.targetPeerId === this.identity?.peerId) await this.disconnect();
        else await this.refreshGroupMembership(false).catch(() => undefined);
      }
      return;
    }
    if (this.identity && !this.openDataPeers.has(remotePeerId) && !this.revocationOnlyPeers.has(remotePeerId)) return;
    // Uma identidade revogada só pode concluir o handshake e receber o
    // certificado assinado que explica sua remoção. Todo o restante é negado.
    if (this.revocationOnlyPeers.has(remotePeerId)) return;

    if (envelope.type === "chat.message.ack") {
      if (this.channelId) await removeOutbox(this.channelId, envelope.messageId);
      return;
    }

    if (envelope.type === "chat.message") {
      if (envelope.version === 2) {
        if (this.processed.has(envelope.id)) {
          this.sendMessageAck(remotePeerId, envelope.id);
          return;
        }
        if (!this.identity || envelope.authorPeerId !== remotePeerId || !(await this.verifySignedMessage(envelope))) return;
        this.remember(envelope.id);
        const local = signedToLocal(envelope);
        await saveLocalMessage(local);
        this.emitMessage(local);
        this.sendMessageAck(remotePeerId, envelope.id);
        return;
      }
      if (this.processed.has(envelope.id)) return;
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
      const current = (await loadLocalGroups()).find((group) => group.groupId === this.groupId);
      if (!current) return;
      const senderAuthorized = current.ownerPeerId === remotePeerId || (current.administratorPeerIds ?? []).includes(remotePeerId);
      if (!senderAuthorized || !(await this.verifyGroupMembership(envelope))) return;
      // Apenas o proprietário pode mudar cargos. Um snapshot de administrador
      // precisa preservar exatamente a lista de cargos já confiada localmente.
      if (remotePeerId !== current.ownerPeerId
        && (envelope.administratorEpoch !== (current.administratorEpoch ?? 1)
          || JSON.stringify([...envelope.administratorPeerIds].sort()) !== JSON.stringify([...(current.administratorPeerIds ?? [])].sort()))) return;
      const merged = await mergeLocalGroupManifest({
        ...current,
        name: envelope.name,
        avatar: envelope.avatar,
        channels: envelope.channels,
        members: envelope.members,
        ownerPeerId: envelope.ownerPeerId,
        membershipVersion: envelope.membershipVersion,
        manifestVersion: envelope.manifestVersion,
        manifestActorPeerId: envelope.manifestActorPeerId,
        manifestOperationId: envelope.manifestOperationId,
        administratorEpoch: envelope.administratorEpoch,
        administratorGrants: envelope.administratorGrants,
        administratorPeerIds: envelope.administratorPeerIds,
        removedPeerIds: envelope.removedPeerIds,
        removedMembers: envelope.removedMembers,
        revocations: envelope.revocations,
        rendezvousVersion: envelope.rendezvousVersion,
        rendezvousSecret: envelope.rendezvousSecret,
      }, remotePeerId);
      this.installGroupPeers(merged.members ?? [], merged.removedMembers ?? [], merged.revocations ?? []);
      await this.connectPresentTrustedPeers();
      return;
    }
    if (envelope.type === "chat.profile.update") {
      if (envelope.identity.peerId !== remotePeerId || !(await this.verifyCanonical(remotePeerId, envelope.signature, canonicalProfileUpdate(envelope)))) return;
      await updateKnownPeerProfile(envelope.identity);
      this.trustedPeers.set(remotePeerId, envelope.identity);
      this.peerNames.set(remotePeerId, envelope.identity.displayName);
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
    const sessionToken = this.sessionToken;
    const transport = this.transport;
    const channelId = this.channelId;
    if (!sessionToken || !this.identity || !channelId || !transport || !this.openDataPeers.has(remotePeerId) || this.historyRequests.has(remotePeerId)) return;
    const knownIds = (await loadLocalMessages(channelId)).slice(-MAX_HISTORY_IDS).map((message) => message.id);
    if (this.sessionToken !== sessionToken || this.transport !== transport || this.channelId !== channelId || !this.openDataPeers.has(remotePeerId)) return;
    const requestId = crypto.randomUUID();
    const request: HistoryRequestWireMessage = {
      version: 2,
      type: "chat.history.request",
      channelId,
      requestId,
      knownIds,
    };
    this.historyRequests.set(remotePeerId, requestId);
    if (transport.sendData(JSON.stringify(request), remotePeerId) === 0) this.historyRequests.delete(remotePeerId);
  }

  private async respondHistory(remotePeerId: string, request: HistoryRequestWireMessage): Promise<void> {
    const sessionToken = this.sessionToken;
    const transport = this.transport;
    const channelId = this.channelId;
    if (!sessionToken || !channelId || !transport || !this.openDataPeers.has(remotePeerId)) return;
    const known = new Set(request.knownIds);
    const messages = (await loadLocalMessages(channelId))
      .map(localToSignedWire)
      .filter((message): message is SignedChatWireMessage => Boolean(message) && !known.has(message!.id))
      .slice(-MAX_HISTORY_IDS);
    if (this.sessionToken !== sessionToken || this.transport !== transport || this.channelId !== channelId || !this.openDataPeers.has(remotePeerId)) return;

    for (let index = 0; index < messages.length; index += HISTORY_CHUNK_MESSAGES) {
      if (!this.isSessionPeerActive(sessionToken, remotePeerId)) return;
      const chunk: HistoryChunkWireMessage = {
        version: 2,
        type: "chat.history.chunk",
        channelId,
        requestId: request.requestId,
        messages: messages.slice(index, index + HISTORY_CHUNK_MESSAGES),
      };
      if (transport.sendData(JSON.stringify(chunk), remotePeerId) === 0) return;
    }
    if (!this.isSessionPeerActive(sessionToken, remotePeerId)) return;
    const complete: HistoryCompleteWireMessage = {
      version: 2,
      type: "chat.history.complete",
      channelId,
      requestId: request.requestId,
    };
    transport.sendData(JSON.stringify(complete), remotePeerId);
  }

  private async refreshGroupMembership(broadcast: boolean): Promise<void> {
    const sessionToken = this.sessionToken;
    const groupId = this.groupId;
    const identity = this.identity;
    if (!sessionToken || !groupId || !identity) return;
    if (this.refreshingMembers) return this.refreshingMembers;
    let task: Promise<void>;
    task = (async () => {
      const group = (await loadLocalGroups()).find((item) => item.groupId === groupId);
      if (!group || this.sessionToken !== sessionToken || this.groupId !== groupId || this.identity !== identity) return;
      const channelId = this.channelId;
      const nextRendezvousId = channelId ? groupRendezvousId(group, "chat", channelId) : undefined;
      const rendezvousChanged = Boolean(nextRendezvousId && this.rendezvousId && nextRendezvousId !== this.rendezvousId);
      this.installGroupPeers(group.members ?? [], group.removedMembers ?? [], group.revocations ?? []);
      await this.connectPresentTrustedPeers();
      if (this.sessionToken !== sessionToken) return;
      if (broadcast) await Promise.all([...this.openDataPeers].map((peerId) => this.sendGroupMembership(peerId)));
      if (this.sessionToken !== sessionToken) return;
      const signaling = this.signaling;
      const peerId = this.peerId;
      if (rendezvousChanged && nextRendezvousId && signaling && peerId) {
        this.rendezvousId = nextRendezvousId;
        this.setStatus("connecting");
        await signaling.connect(nextRendezvousId, peerId, this.signalingNamespace);
        if (this.sessionToken !== sessionToken || this.signaling !== signaling) return;
        this.setStatus("connected");
        await this.connectPresentTrustedPeers();
      }
    })().finally(() => {
      if (this.refreshingMembers === task) this.refreshingMembers = undefined;
    });
    this.refreshingMembers = task;
    return task;
  }

  private installGroupPeers(activePeers: PublicPeerIdentity[], revokedPeers: PublicPeerIdentity[], revocations: GroupRevocationCertificate[]): void {
    const active = new Map(activePeers.map((peer) => [peer.peerId, peer]));
    const revoked = new Map(revokedPeers.filter((peer) => !active.has(peer.peerId)).map((peer) => [peer.peerId, peer]));
    this.trustedPeers.clear();
    this.revokedPeers.clear();
    this.verifyKeys.clear();
    this.peerNames.clear();
    for (const peer of active.values()) {
      this.trustedPeers.set(peer.peerId, peer);
      this.peerNames.set(peer.peerId, peer.displayName);
    }
    for (const peer of revoked.values()) this.revokedPeers.set(peer.peerId, peer);
    this.revocations = revocations.filter(validGroupRevocationCertificate);

    for (const remotePeerId of [...this.dataChannelPeers]) {
      if (this.revokedPeers.has(remotePeerId)) {
        this.openDataPeers.delete(remotePeerId);
        this.attachmentService?.forgetPeer(remotePeerId);
        this.markRevokedPeerReady(remotePeerId);
      } else if (!this.trustedPeers.has(remotePeerId)) {
        this.forgetPeerConnection(remotePeerId);
        void this.transport?.disconnect(remotePeerId);
      }
    }
  }

  private async connectPresentTrustedPeers(): Promise<void> {
    if (!this.signaling || !this.peerId) return;
    const present = this.signaling.getDiagnostics().presencePeers;
    await Promise.all(present.filter((peerId) => this.isTrustedRemote(peerId)).map((peerId) => this.connectTrustedPeer(peerId, this.peerId)));
  }

  private async sendGroupMembership(remotePeerId: string): Promise<void> {
    const sessionToken = this.sessionToken;
    const groupId = this.groupId;
    const identity = this.identity;
    const channelId = this.channelId;
    const transport = this.transport;
    if (!sessionToken || !groupId || !identity || !channelId || !transport || !this.openDataPeers.has(remotePeerId)) return;
    const group = (await loadLocalGroups()).find((item) => item.groupId === groupId);
    if (this.sessionToken !== sessionToken || this.transport !== transport || !this.openDataPeers.has(remotePeerId)) return;
    if (!group || (group.ownerPeerId !== identity.peerId && !(group.administratorPeerIds ?? []).includes(identity.peerId))) return;
    const members = (group.members ?? []).slice(0, MAX_GROUP_SYNC_MEMBERS).map(({ avatar: _avatar, ...member }) => member);
    const removedMembers = (group.removedMembers ?? []).slice(0, MAX_GROUP_SYNC_MEMBERS).map(({ avatar: _avatar, ...member }) => member);
    const unsigned: Omit<GroupMembersWireMessage, "signature"> = {
      version: 2,
      type: "chat.members.snapshot",
      channelId,
      groupId,
      senderPeerId: identity.peerId,
      ownerPeerId: group.ownerPeerId,
      membershipVersion: group.membershipVersion,
      manifestVersion: group.manifestVersion,
      manifestActorPeerId: group.manifestActorPeerId ?? group.ownerPeerId,
      manifestOperationId: group.manifestOperationId ?? `legacy-${group.manifestVersion}`,
      administratorEpoch: group.administratorEpoch ?? 1,
      administratorGrants: group.administratorGrants ?? [],
      name: group.name,
      avatar: group.avatar,
      channels: group.channels,
      administratorPeerIds: group.administratorPeerIds ?? [],
      removedPeerIds: group.removedPeerIds ?? [],
      removedMembers,
      revocations: (group.revocations ?? []).slice(-MAX_GROUP_SYNC_REVOCATIONS),
      rendezvousVersion: group.rendezvousVersion ?? 1,
      rendezvousSecret: group.rendezvousSecret ?? group.groupId,
      members,
      timestamp: Date.now(),
    };
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(canonicalGroupMembership(unsigned)),
    );
    if (this.sessionToken !== sessionToken || this.transport !== transport || !this.openDataPeers.has(remotePeerId)) return;
    const message: GroupMembersWireMessage = { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
    const serialized = JSON.stringify(message);
    if (new TextEncoder().encode(serialized).byteLength > MAX_WIRE_BYTES) {
      throw new Error("O manifesto do grupo excedeu o limite P2P seguro. Reduza a imagem do grupo, canais ou histórico de membros antes de sincronizar.");
    }
    transport.sendData(serialized, remotePeerId);
  }

  private async sendRevocations(remotePeerId: string): Promise<void> {
    if (!this.channelId || !this.transport || !this.revocationOnlyPeers.has(remotePeerId)) return;
    for (const certificate of this.revocations.filter((item) => item.targetPeerId === remotePeerId)) {
      const message: GroupRevocationWireMessage = {
        version: 2,
        type: "chat.group.revocation",
        channelId: this.channelId,
        certificate,
      };
      this.transport.sendData(JSON.stringify(message), remotePeerId);
    }
  }

  private async sendProfileUpdate(remotePeerId: string): Promise<void> {
    const sessionToken = this.sessionToken;
    const identity = this.identity;
    const channelId = this.channelId;
    const transport = this.transport;
    if (!sessionToken || !identity || !channelId || !transport || !this.openDataPeers.has(remotePeerId)) return;
    const unsigned: Omit<ProfileUpdateWireMessage, "signature"> = {
      version: 2,
      type: "chat.profile.update",
      channelId,
      identity: {
        peerId: identity.peerId,
        publicKey: identity.publicKey,
        displayName: identity.displayName,
        avatar: identity.avatar,
      },
      timestamp: Date.now(),
    };
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(canonicalProfileUpdate(unsigned)),
    );
    if (this.sessionToken !== sessionToken || this.transport !== transport || !this.openDataPeers.has(remotePeerId)) return;
    const message: ProfileUpdateWireMessage = { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
    transport.sendData(JSON.stringify(message), remotePeerId);
  }

  private sendToAuthenticatedPeers(data: string): number {
    if (!this.transport) return 0;
    let sent = 0;
    for (const peerId of this.openDataPeers) sent += this.transport.sendData(data, peerId);
    return sent;
  }

  private async createSignedMessage(channelId: string, content: string, timestamp: number): Promise<SignedChatWireMessage> {
    if (!this.identity) throw new Error("Identidade P2P indisponível para assinar dados.");
    const unsigned: Omit<SignedChatWireMessage, "signature"> = {
      version: 2, type: "chat.message", channelId, id: crypto.randomUUID(), authorPeerId: this.identity.peerId,
      author: this.displayName, content, timestamp,
    };
    return { ...unsigned, signature: await this.signCanonical(canonicalSignedMessage(unsigned)) };
  }

  private async flushOutbox(remotePeerId: string): Promise<void> {
    const sessionToken = this.sessionToken;
    const channelId = this.channelId;
    const transport = this.transport;
    if (!sessionToken || !channelId || !transport || !this.openDataPeers.has(remotePeerId)) return;
    const records = await loadOutbox(channelId);
    if (this.sessionToken !== sessionToken || this.transport !== transport || this.channelId !== channelId) return;
    for (const record of records) {
      if (!this.isSessionPeerActive(sessionToken, remotePeerId)) return;
      const envelope = parseChatWireEnvelope(record.wire, channelId);
      if (!envelope || envelope.type !== "chat.message" || envelope.version !== 2) {
        await removeOutbox(channelId, record.messageId);
        continue;
      }
      if (transport.sendData(record.wire, remotePeerId) > 0) await markOutboxAttempt(record);
    }
  }

  private sendMessageAck(remotePeerId: string, messageId: string): void {
    if (!this.channelId || !this.transport || !this.openDataPeers.has(remotePeerId)) return;
    const ack: MessageAckWireMessage = { version: 2, type: "chat.message.ack", channelId: this.channelId, messageId };
    this.transport.sendData(JSON.stringify(ack), remotePeerId);
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
    const peer = this.trustedPeers.get(peerId) ?? this.revokedPeers.get(peerId);
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
): Promise<{ groupId: string; identity: LocalIdentity; trustedPeers: PublicPeerIdentity[]; revokedPeers: PublicPeerIdentity[]; revocations: GroupRevocationCertificate[]; rendezvousId: string } | null> {
  const group = (await loadLocalGroups()).find((item) => item.channels.some((channel) => channel.kind === "text" && channel.id === channelId));
  if (!group) return null;
  return {
    groupId: group.groupId,
    identity: await getOrCreateLocalIdentity(displayName),
    trustedPeers: group.members ?? [],
    revokedPeers: group.removedMembers ?? [],
    revocations: group.revocations ?? [],
    rendezvousId: groupRendezvousId(group, "chat", channelId),
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
  if (message.version === 2 && message.type === "chat.group.revocation" && validGroupRevocationCertificate(message.certificate)) {
    return { version: 2, type: "chat.group.revocation", channelId: channelId!, certificate: message.certificate };
  }
  if (message.version === 2 && message.type === "chat.profile.update") return parseProfileUpdate(message, channelId);
  if (message.version === 2 && message.type === "chat.message.ack" && validWireId(message.messageId)) {
    return { version: 2, type: "chat.message.ack", channelId: channelId!, messageId: message.messageId };
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
    && (allowHistorical || message.timestamp >= now - QUEUED_MESSAGE_MAX_AGE_MS);
  return message.version === 2 && message.type === "chat.message" && message.channelId === channelId
    && validWireId(message.id) && validWireId(message.authorPeerId)
    && typeof message.author === "string" && message.author.trim().length >= 2 && message.author.length <= 80
    && typeof message.content === "string" && message.content.trim().length > 0 && message.content.length <= 4_000
    && typeof message.signature === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(message.signature)
    && timestampValid
    ? message as unknown as SignedChatWireMessage : null;
}

function parseIdentityChallenge(message: Record<string, unknown>, channelId?: string): IdentityChallengeWireMessage | null {
  if (!validWireId(message.fromPeerId) || !validWireId(message.nonce) || !freshTimestamp(message.timestamp) || !validRiskPeerCapabilities(message.capabilities)) return null;
  return {
    version: 2,
    type: "chat.identity.challenge",
    channelId: channelId!,
    fromPeerId: message.fromPeerId,
    nonce: message.nonce,
    timestamp: message.timestamp,
    capabilities: message.capabilities,
  } as IdentityChallengeWireMessage;
}

function parseIdentityProof(message: Record<string, unknown>, channelId?: string): IdentityProofWireMessage | null {
  if (!validWireId(message.fromPeerId) || !validWireId(message.toPeerId) || !validWireId(message.nonce) || !freshTimestamp(message.timestamp) || !validRiskPeerCapabilities(message.capabilities)) return null;
  if (typeof message.signature !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(message.signature)) return null;
  return {
    version: 2,
    type: "chat.identity.proof",
    channelId: channelId!,
    fromPeerId: message.fromPeerId,
    toPeerId: message.toPeerId,
    nonce: message.nonce,
    timestamp: message.timestamp,
    capabilities: message.capabilities,
    signature: message.signature,
  } as IdentityProofWireMessage;
}

function parseGroupMembership(message: Record<string, unknown>, channelId?: string): GroupMembersWireMessage | null {
  if (!validWireId(message.groupId) || !validWireId(message.senderPeerId)) return null;
  if (!validWireId(message.ownerPeerId) || !Number.isSafeInteger(message.membershipVersion) || Number(message.membershipVersion) < 1) return null;
  if (!Array.isArray(message.members) || message.members.length === 0 || message.members.length > MAX_GROUP_SYNC_MEMBERS) return null;
  if (!Number.isSafeInteger(message.manifestVersion) || Number(message.manifestVersion) < 1) return null;
  if (!validWireId(message.manifestActorPeerId) || !validWireId(message.manifestOperationId)) return null;
  if (!Number.isSafeInteger(message.administratorEpoch) || Number(message.administratorEpoch) < 1) return null;
  if (!Array.isArray(message.administratorGrants) || message.administratorGrants.length > MAX_GROUP_SYNC_MEMBERS || !message.administratorGrants.every(validGroupAdministratorGrant)) return null;
  if (typeof message.name !== "string" || message.name.trim().length < 2 || message.name.length > 80) return null;
  if (message.avatar !== undefined && !validAvatarDataUrl(message.avatar)) return null;
  if (!Array.isArray(message.channels) || message.channels.length > 100 || !message.channels.every(isLocalGroupChannel)) return null;
  if (!Array.isArray(message.administratorPeerIds) || message.administratorPeerIds.length > 64 || !message.administratorPeerIds.every(validWireId)) return null;
  if (!Array.isArray(message.removedPeerIds) || message.removedPeerIds.length > 256 || !message.removedPeerIds.every(validWireId)) return null;
  if (!Array.isArray(message.removedMembers) || message.removedMembers.length > MAX_GROUP_SYNC_MEMBERS || !message.removedMembers.every(isPublicPeerIdentity)) return null;
  if (!Array.isArray(message.revocations) || message.revocations.length > MAX_GROUP_SYNC_REVOCATIONS || !message.revocations.every(validGroupRevocationCertificate)) return null;
  if (!Number.isSafeInteger(message.rendezvousVersion) || Number(message.rendezvousVersion) < 1 || !validWireId(message.rendezvousSecret)) return null;
  if (!message.members.every(isPublicPeerIdentity) || !freshTimestamp(message.timestamp)) return null;
  if (typeof message.signature !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(message.signature)) return null;
  return {
    version: 2,
    type: "chat.members.snapshot",
    channelId: channelId!,
    groupId: message.groupId,
    senderPeerId: message.senderPeerId,
    ownerPeerId: message.ownerPeerId,
    membershipVersion: Number(message.membershipVersion),
    manifestVersion: Number(message.manifestVersion),
    manifestActorPeerId: message.manifestActorPeerId,
    manifestOperationId: message.manifestOperationId,
    administratorEpoch: Number(message.administratorEpoch),
    administratorGrants: message.administratorGrants,
    name: message.name,
    avatar: typeof message.avatar === "string" ? message.avatar : undefined,
    channels: message.channels,
    administratorPeerIds: [...new Set(message.administratorPeerIds as string[])],
    removedPeerIds: [...new Set(message.removedPeerIds as string[])],
    removedMembers: message.removedMembers,
    revocations: message.revocations,
    rendezvousVersion: Number(message.rendezvousVersion),
    rendezvousSecret: message.rendezvousSecret,
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
    capabilities: message.capabilities,
  });
}

function canonicalGroupMembership(message: Omit<GroupMembersWireMessage, "signature"> | GroupMembersWireMessage): string {
  return JSON.stringify({
    version: 2,
    type: "chat.members.snapshot",
    channelId: message.channelId,
    groupId: message.groupId,
    senderPeerId: message.senderPeerId,
    ownerPeerId: message.ownerPeerId,
    membershipVersion: message.membershipVersion,
    manifestVersion: message.manifestVersion,
    manifestActorPeerId: message.manifestActorPeerId,
    manifestOperationId: message.manifestOperationId,
    administratorEpoch: message.administratorEpoch,
    administratorGrants: [...message.administratorGrants].sort((left, right) => left.administratorPeerId.localeCompare(right.administratorPeerId)),
    name: message.name,
    avatar: message.avatar ?? null,
    channels: [...message.channels].sort((left, right) => left.id.localeCompare(right.id)),
    administratorPeerIds: [...message.administratorPeerIds].sort(),
    removedPeerIds: [...message.removedPeerIds].sort(),
    removedMembers: canonicalPeerIdentities(message.removedMembers),
    revocations: [...message.revocations].sort((left, right) => left.messageId.localeCompare(right.messageId)),
    rendezvousVersion: message.rendezvousVersion,
    rendezvousSecret: message.rendezvousSecret,
    members: canonicalPeerIdentities(message.members),
    timestamp: message.timestamp,
  });
}

function canonicalPeerIdentities(members: PublicPeerIdentity[]): object[] {
  return [...members].sort((left, right) => left.peerId.localeCompare(right.peerId)).map((member) => ({
    peerId: member.peerId,
    displayName: member.displayName,
    avatar: member.avatar ?? null,
    publicKey: {
      kty: member.publicKey.kty ?? null,
      crv: member.publicKey.crv ?? null,
      x: member.publicKey.x ?? null,
      y: member.publicKey.y ?? null,
    },
  }));
}

function canonicalProfileUpdate(message: Omit<ProfileUpdateWireMessage, "signature"> | ProfileUpdateWireMessage): string {
  return JSON.stringify({
    version: 2,
    type: "chat.profile.update",
    channelId: message.channelId,
    identity: {
      peerId: message.identity.peerId,
      displayName: message.identity.displayName,
      avatar: message.identity.avatar ?? null,
      publicKey: {
        kty: message.identity.publicKey.kty ?? null,
        crv: message.identity.publicKey.crv ?? null,
        x: message.identity.publicKey.x ?? null,
        y: message.identity.publicKey.y ?? null,
      },
    },
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
  if (identity.avatar !== undefined && !validAvatarDataUrl(identity.avatar)) return false;
  if (!identity.publicKey || typeof identity.publicKey !== "object") return false;
  const key = identity.publicKey as JsonWebKey;
  return key.kty === "EC" && key.crv === "P-256"
    && typeof key.x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key.x)
    && typeof key.y === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key.y);
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

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function parseProfileUpdate(message: Record<string, unknown>, channelId?: string): ProfileUpdateWireMessage | null {
  if (!isPublicPeerIdentity(message.identity) || !freshTimestamp(message.timestamp)) return null;
  if (typeof message.signature !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(message.signature)) return null;
  return { version: 2, type: "chat.profile.update", channelId: channelId!, identity: message.identity, timestamp: message.timestamp, signature: message.signature };
}

function isLocalGroupChannel(value: unknown): value is LocalGroupChannel {
  if (!value || typeof value !== "object") return false;
  const channel = value as Record<string, unknown>;
  return validWireId(channel.id) && typeof channel.name === "string" && channel.name.trim().length >= 1 && channel.name.length <= 80
    && (channel.kind === "text" || channel.kind === "voice")
    && (channel.voiceRoomId === undefined || channel.voiceRoomId === null || validWireId(channel.voiceRoomId));
}
