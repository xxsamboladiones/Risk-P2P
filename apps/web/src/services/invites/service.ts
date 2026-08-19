import { MeshWebRTCTransport, type TransportEvents } from "@risk/rtc";
import { SupabaseSignalingProvider } from "../supabase/signaling";
import type { SignalingProvider } from "../signaling/types";
import {
  addLocalGroupMember,
  publicIdentity,
  saveLocalFriend,
  saveLocalGroup,
  type LocalIdentity,
  type PublicGroupMetadata,
  type PublicPeerIdentity,
} from "../offline/social-storage";
import {
  deriveInviteRendezvousId,
  generateRiskInviteCode,
  InviteAttemptLimiter,
  normalizeRiskInviteCode,
  type InviteType,
  validateRiskInviteCode,
} from "./code";
import {
  createSignedInviteMessage,
  parseAndVerifyInviteMessage,
  type SignedInviteMessage,
} from "./protocol";

export const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
const CANDIDATE_CONNECT_TIMEOUT_MS = 15_000;
const DECISION_ACK_TIMEOUT_MS = 5_000;
const sharedAttemptLimiter = new InviteAttemptLimiter();

export type InviteStatus =
  | "idle"
  | "waiting"
  | "connecting"
  | "connected"
  | "approval"
  | "confirming"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled"
  | "error";

export type InviteSnapshot = {
  type: InviteType;
  role: "creator" | "joiner";
  code: string;
  createdAt: number;
  expiresAt: number;
  status: InviteStatus;
  message: string;
  remoteIdentity?: PublicPeerIdentity;
};

export type IncomingInviteRequest = {
  requestId: string;
  identity: PublicPeerIdentity;
  type: InviteType;
};

export type InviteTransport = {
  connect(peerId: string, initiator: boolean): Promise<void>;
  acceptOffer(peerId: string, description: RTCSessionDescriptionInit): Promise<void>;
  acceptAnswer(peerId: string, description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void>;
  sendData(data: string, targetPeerId?: string): number;
  disconnect(peerId?: string): Promise<void>;
};

export type InviteDependencies = {
  createSignaling(): SignalingProvider;
  createTransport(
    peerId: string,
    iceServers: RTCIceServer[],
    events: TransportEvents,
  ): InviteTransport;
  now(): number;
  setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};

const defaults: InviteDependencies = {
  createSignaling: () => new SupabaseSignalingProvider(),
  createTransport: (peerId, iceServers, events) =>
    new MeshWebRTCTransport(peerId, iceServers, events),
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

export class InviteService {
  private signaling?: SignalingProvider;
  private transport?: InviteTransport;
  private snapshot?: InviteSnapshot;
  private localPeerId?: string;
  private candidatePeerId?: string;
  private request?: IncomingInviteRequest;
  private requestId?: string;
  private group?: PublicGroupMetadata;
  private pendingDecision?: "accept" | "reject";
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private availabilityTimer?: ReturnType<typeof setTimeout>;
  private candidateTimer?: ReturnType<typeof setTimeout>;
  private decisionTimer?: ReturnType<typeof setTimeout>;
  private unsubscribers: Array<() => void> = [];
  private readonly stateListeners = new Set<(snapshot: InviteSnapshot) => void>();
  private readonly requestListeners = new Set<(request: IncomingInviteRequest) => void>();
  private cleaned = false;

  constructor(
    private readonly identity: LocalIdentity,
    private readonly iceServers: RTCIceServer[],
    private readonly dependencies: InviteDependencies = defaults,
  ) {}

  onState(callback: (snapshot: InviteSnapshot) => void): () => void {
    this.stateListeners.add(callback);
    if (this.snapshot) callback(this.snapshot);
    return () => this.stateListeners.delete(callback);
  }

  onRequest(callback: (request: IncomingInviteRequest) => void): () => void {
    this.requestListeners.add(callback);
    if (this.request) callback(this.request);
    return () => this.requestListeners.delete(callback);
  }

  get state(): InviteSnapshot | undefined {
    return this.snapshot;
  }

  async createInvite(
    type: InviteType,
    group?: PublicGroupMetadata,
    ttlMs = DEFAULT_INVITE_TTL_MS,
  ): Promise<InviteSnapshot> {
    await this.cancel(false);
    this.cleaned = false;
    if (type === "group" && !group) {
      throw new Error("Selecione um grupo para criar o convite.");
    }
    this.group = group;
    return this.start(type, "creator", generateRiskInviteCode(), ttlMs);
  }

  async joinInvite(
    type: InviteType,
    input: string,
    ttlMs = DEFAULT_INVITE_TTL_MS,
  ): Promise<InviteSnapshot> {
    if (!sharedAttemptLimiter.consume()) {
      throw new Error("Muitas tentativas. Aguarde um minuto antes de tentar novamente.");
    }
    const code = normalizeRiskInviteCode(input);
    if (!validateRiskInviteCode(code)) throw new Error("Digite um código Risk válido.");
    await this.cancel(false);
    this.cleaned = false;
    return this.start(type, "joiner", code, ttlMs);
  }

  async accept(): Promise<void> {
    if (this.snapshot?.role !== "creator" || !this.request || !this.candidatePeerId) {
      throw new Error("Não há solicitação aguardando aprovação.");
    }
    const type = this.snapshot.type === "friend" ? "friend.accept" : "group.join.accept";
    await this.send(
      type,
      this.request.requestId,
      this.snapshot.type === "group" ? this.group : undefined,
    );
    this.pendingDecision = "accept";
    this.update("confirming", "Aceite enviado. Aguardando confirmação do outro dispositivo…");
    this.armDecisionTimeout();
  }

  async reject(): Promise<void> {
    if (this.snapshot?.role !== "creator" || !this.request || !this.candidatePeerId) return;
    const type = this.snapshot.type === "friend" ? "friend.reject" : "group.join.reject";
    await this.send(type, this.request.requestId);
    this.pendingDecision = "reject";
    this.update("confirming", "Recusa enviada. Aguardando confirmação…");
    this.armDecisionTimeout();
  }

  async cancel(markCancelled = true): Promise<void> {
    if (
      markCancelled
      && this.snapshot
      && !["accepted", "rejected", "expired"].includes(this.snapshot.status)
    ) {
      this.update("cancelled", "Convite cancelado");
    }
    await this.cleanup();
  }

  private async start(
    type: InviteType,
    role: "creator" | "joiner",
    code: string,
    ttlMs: number,
  ): Promise<InviteSnapshot> {
    const now = this.dependencies.now();
    this.snapshot = {
      type,
      role,
      code,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: role === "creator" ? "waiting" : "connecting",
      message: role === "creator" ? "Aguardando alguém entrar…" : "Procurando convite…",
    };
    this.pendingDecision = undefined;
    this.emitState();
    this.localPeerId = crypto.randomUUID();
    this.signaling = this.dependencies.createSignaling();
    this.transport = this.dependencies.createTransport(
      this.localPeerId,
      this.iceServers,
      this.transportEvents(),
    );
    this.bindSignaling();
    const rendezvous = await deriveInviteRendezvousId(type, code);

    try {
      await this.signaling.connect(rendezvous, this.localPeerId, type);
    } catch (error) {
      this.update("error", "Não foi possível conectar ao serviço de convites.");
      await this.cleanup();
      throw error;
    }

    this.expiryTimer = this.dependencies.setTimer(() => {
      this.update("expired", "Convite expirado");
      void this.cleanup();
    }, ttlMs);

    if (role === "joiner") {
      this.availabilityTimer = this.dependencies.setTimer(() => {
        if (!this.candidatePeerId && this.snapshot?.status === "connecting") {
          this.update("error", "Convite não encontrado, expirado ou o criador está offline.");
          void this.cleanup();
        }
      }, Math.min(12_000, ttlMs));
    }
    return this.snapshot;
  }

  private bindSignaling(): void {
    const signaling = this.signaling!;
    this.unsubscribers.push(
      signaling.onPeerJoined((peer) => {
        if (!this.snapshot || this.candidatePeerId === peer.peerId || this.candidatePeerId) return;
        this.candidatePeerId = peer.peerId;
        if (this.availabilityTimer) this.dependencies.clearTimer(this.availabilityTimer);
        this.availabilityTimer = undefined;
        this.update("connecting", "Negociando conexão P2P…");
        this.armCandidateTimeout(peer.peerId);
        void this.transport!
          .connect(peer.peerId, this.snapshot.role === "creator")
          .catch(() => this.failCandidate(peer.peerId));
      }),
      signaling.onPeerLeft((peerId) => {
        if (
          peerId === this.candidatePeerId
          && this.snapshot
          && !["accepted", "rejected", "expired", "cancelled"].includes(this.snapshot.status)
        ) {
          void this.failCandidate(peerId);
        }
      }),
      signaling.onOffer((message) => {
        if (this.acceptCandidate(message.fromPeerId)) {
          void this.transport!
            .acceptOffer(message.fromPeerId, message.payload.sdp)
            .catch(() => this.failCandidate(message.fromPeerId));
        }
      }),
      signaling.onAnswer((message) => {
        if (this.acceptCandidate(message.fromPeerId)) {
          void this.transport!
            .acceptAnswer(message.fromPeerId, message.payload.sdp)
            .catch(() => this.failCandidate(message.fromPeerId));
        }
      }),
      signaling.onIceCandidate((message) => {
        if (this.acceptCandidate(message.fromPeerId)) {
          void this.transport!
            .addIceCandidate(message.fromPeerId, message.payload.candidate)
            .catch(() => undefined);
        }
      }),
    );
  }

  private transportEvents(): TransportEvents {
    return {
      sendOffer: (peerId, description) => this.signaling!.sendOffer(peerId, description),
      sendAnswer: (peerId, description) => this.signaling!.sendAnswer(peerId, description),
      sendIce: (peerId, candidate) => this.signaling!.sendIceCandidate(peerId, candidate),
      onRemoteStream: () => undefined,
      onConnectionState: (peerId, state) => {
        if ((state === "failed" || state === "closed") && this.snapshot?.status !== "accepted") {
          void this.failCandidate(peerId);
        }
      },
      onDataState: (peerId, state) => {
        if (peerId !== this.candidatePeerId || state !== "open" || !this.snapshot) return;
        this.clearCandidateTimeout();
        this.update("connected", "Conexão P2P estabelecida");
        if (this.snapshot.role === "joiner") {
          this.requestId = crypto.randomUUID();
          const type = this.snapshot.type === "friend" ? "friend.request" : "group.join.request";
          void this.send(type, this.requestId)
            .then(() => this.update("approval", "Solicitação enviada. Aguardando aprovação…"))
            .catch(() => this.failCurrent("Não foi possível enviar a solicitação."));
        }
      },
      onDataMessage: (peerId, data) => {
        if (peerId === this.candidatePeerId) {
          void this.receive(data).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Falha ao processar resposta do convite.";
            this.failCurrent(message);
          });
        }
      },
    };
  }

  private async receive(raw: string): Promise<void> {
    const message = await parseAndVerifyInviteMessage(raw, this.dependencies.now());
    if (!message || !this.snapshot) return;
    const expectedRequest = this.snapshot.type === "friend" ? "friend.request" : "group.join.request";

    if (this.snapshot.role === "creator") {
      if (
        message.type === "invite.ack"
        && this.request
        && message.requestId === this.request.requestId
        && this.pendingDecision
      ) {
        const decision = this.pendingDecision;
        this.pendingDecision = undefined;
        if (decision === "accept") {
          const remote = this.request.identity;
          if (this.snapshot.type === "friend") {
            await saveLocalFriend({ ...remote, addedAt: this.dependencies.now() });
          } else {
            if (!this.group) throw new Error("Metadados do grupo indisponíveis.");
            await addLocalGroupMember(this.group, remote, publicIdentity(this.identity));
          }
          this.snapshot = { ...this.snapshot, remoteIdentity: remote };
          await this.finishWithStatus(
            "accepted",
            this.snapshot.type === "friend" ? "Amizade concluída" : "Entrada no grupo concluída",
          );
        } else {
          await this.finishWithStatus("rejected", "Solicitação recusada");
        }
        return;
      }

      if (message.type !== expectedRequest || this.request || this.pendingDecision) return;
      this.request = {
        requestId: message.requestId,
        identity: message.identity,
        type: this.snapshot.type,
      };
      this.snapshot = { ...this.snapshot, remoteIdentity: message.identity };
      this.update(
        "approval",
        this.snapshot.type === "friend"
          ? `${message.identity.displayName} quer adicionar você`
          : `${message.identity.displayName} quer entrar no grupo`,
      );
      this.requestListeners.forEach((callback) => callback(this.request!));
      return;
    }

    if (!this.requestId || message.requestId !== this.requestId) return;
    const accepted = this.snapshot.type === "friend"
      ? message.type === "friend.accept"
      : message.type === "group.join.accept";
    const rejected = this.snapshot.type === "friend"
      ? message.type === "friend.reject"
      : message.type === "group.join.reject";

    if (accepted) {
      if (this.snapshot.type === "friend") {
        await saveLocalFriend({ ...message.identity, addedAt: this.dependencies.now() });
      } else if (message.group) {
        await saveLocalGroup({
          ...message.group,
          members: [message.identity, publicIdentity(this.identity)],
          joinedAt: this.dependencies.now(),
        });
      } else {
        return;
      }
      this.snapshot = { ...this.snapshot, remoteIdentity: message.identity };
      await this.sendAck(this.requestId);
      await this.finishWithStatus(
        "accepted",
        this.snapshot.type === "friend" ? "Amizade concluída" : "Entrada no grupo concluída",
      );
    } else if (rejected) {
      await this.sendAck(this.requestId);
      await this.finishWithStatus("rejected", "Solicitação recusada");
    }
  }

  private async send(
    type: SignedInviteMessage["type"],
    requestId: string,
    group?: PublicGroupMetadata,
  ): Promise<void> {
    if (!this.transport || !this.candidatePeerId) {
      throw new Error("Conexão P2P indisponível.");
    }
    const message = await createSignedInviteMessage(this.identity, {
      type,
      requestId,
      timestamp: this.dependencies.now(),
      group,
    });
    if (this.transport.sendData(JSON.stringify(message), this.candidatePeerId) !== 1) {
      throw new Error("DataChannel indisponível.");
    }
  }

  private async sendAck(requestId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.send("invite.ack", requestId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Não foi possível confirmar o convite.");
  }

  private armCandidateTimeout(peerId: string): void {
    this.clearCandidateTimeout();
    const remaining = Math.max(
      1,
      (this.snapshot?.expiresAt ?? this.dependencies.now()) - this.dependencies.now(),
    );
    this.candidateTimer = this.dependencies.setTimer(() => {
      if (
        this.candidatePeerId === peerId
        && this.snapshot
        && ["connecting", "waiting"].includes(this.snapshot.status)
      ) {
        void this.failCandidate(peerId);
      }
    }, Math.min(CANDIDATE_CONNECT_TIMEOUT_MS, remaining));
  }

  private clearCandidateTimeout(): void {
    if (this.candidateTimer) this.dependencies.clearTimer(this.candidateTimer);
    this.candidateTimer = undefined;
  }

  private armDecisionTimeout(): void {
    if (this.decisionTimer) this.dependencies.clearTimer(this.decisionTimer);
    this.decisionTimer = this.dependencies.setTimer(() => {
      if (this.snapshot?.status === "confirming") {
        this.pendingDecision = undefined;
        this.failCurrent("O outro dispositivo não confirmou a operação. Tente novamente.");
      }
    }, DECISION_ACK_TIMEOUT_MS);
  }

  private acceptCandidate(peerId: string): boolean {
    if (!this.candidatePeerId) {
      this.candidatePeerId = peerId;
      this.armCandidateTimeout(peerId);
    }
    return this.candidatePeerId === peerId;
  }

  private async failCandidate(peerId: string): Promise<void> {
    if (peerId !== this.candidatePeerId || !this.snapshot) return;
    if (["accepted", "rejected", "expired", "cancelled"].includes(this.snapshot.status)) return;
    this.clearCandidateTimeout();
    await this.transport?.disconnect(peerId).catch(() => undefined);
    this.candidatePeerId = undefined;
    this.request = undefined;
    this.requestId = undefined;
    this.pendingDecision = undefined;
    if (this.snapshot.role === "creator" && this.dependencies.now() < this.snapshot.expiresAt) {
      this.update("waiting", "Aguardando alguém entrar…");
    } else {
      this.update("error", "Não foi possível estabelecer conexão.");
      await this.cleanup();
    }
  }

  private failCurrent(message: string): void {
    if (!this.snapshot || ["accepted", "rejected", "expired", "cancelled"].includes(this.snapshot.status)) return;
    this.update("error", message);
    void this.cleanup();
  }

  private update(status: InviteStatus, message: string): void {
    if (!this.snapshot) return;
    this.snapshot = { ...this.snapshot, status, message };
    this.emitState();
  }

  private emitState(): void {
    if (this.snapshot) this.stateListeners.forEach((callback) => callback(this.snapshot!));
  }

  private async finishWithStatus(status: "accepted" | "rejected", message: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.cleanup();
    this.update(status, message);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("risk:social-updated"));
    }
  }

  private async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.expiryTimer) this.dependencies.clearTimer(this.expiryTimer);
    if (this.availabilityTimer) this.dependencies.clearTimer(this.availabilityTimer);
    if (this.candidateTimer) this.dependencies.clearTimer(this.candidateTimer);
    if (this.decisionTimer) this.dependencies.clearTimer(this.decisionTimer);
    this.expiryTimer = undefined;
    this.availabilityTimer = undefined;
    this.candidateTimer = undefined;
    this.decisionTimer = undefined;
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    await this.transport?.disconnect().catch(() => undefined);
    await this.signaling?.disconnect().catch(() => undefined);
    this.transport = undefined;
    this.signaling = undefined;
    this.localPeerId = undefined;
    this.candidatePeerId = undefined;
    this.request = undefined;
    this.requestId = undefined;
    this.pendingDecision = undefined;
  }
}

export class FriendInviteService extends InviteService {
  createFriendInvite(ttlMs?: number): Promise<InviteSnapshot> {
    return this.createInvite("friend", undefined, ttlMs);
  }

  joinFriendInvite(code: string, ttlMs?: number): Promise<InviteSnapshot> {
    return this.joinInvite("friend", code, ttlMs);
  }
}

export class GroupInviteService extends InviteService {
  createGroupInvite(group: PublicGroupMetadata, ttlMs?: number): Promise<InviteSnapshot> {
    return this.createInvite("group", group, ttlMs);
  }

  joinGroupInvite(code: string, ttlMs?: number): Promise<InviteSnapshot> {
    return this.joinInvite("group", code, ttlMs);
  }
}
