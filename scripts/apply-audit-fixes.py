from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
changed: list[str] = []


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    previous = target.read_text(encoding="utf-8") if target.exists() else None
    if previous == content:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    changed.append(path)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    text = read(path)
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f"{path}: start marker not found: {start!r}")
    end_index = text.find(end, start_index + len(start))
    if end_index < 0:
        raise RuntimeError(f"{path}: end marker not found: {end!r}")
    write(path, text[:start_index] + replacement + text[end_index:])


def insert_before(path: str, marker: str, addition: str) -> None:
    text = read(path)
    index = text.find(marker)
    if index < 0:
        raise RuntimeError(f"{path}: marker not found: {marker!r}")
    if addition in text:
        return
    write(path, text[:index] + addition + text[index:])


# 1 + 2: Chat lifecycle hardening. The session token is installed before any
# asynchronous setup, every post-await mutation is tied to the active session,
# and obsolete peer preparation cannot turn a deliberate disconnect into error.
chat = "apps/web/src/chat.ts"
replace_between(
    chat,
    "  async connect(\n",
    "\n  async disconnect(): Promise<void> {",
    r'''  async connect(
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
''',
)

replace_between(
    chat,
    "  private async respondIdentityChallenge(",
    "\n  private async acceptIdentityProof(",
    r'''  private async respondIdentityChallenge(remotePeerId: string, challenge: IdentityChallengeWireMessage): Promise<void> {
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
''',
)

replace_between(
    chat,
    "  private async acceptIdentityProof(",
    "\n  private rejectIncompatibleIdentityEnvelope(",
    r'''  private async acceptIdentityProof(remotePeerId: string, proof: IdentityProofWireMessage): Promise<void> {
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
''',
)

replace_between(
    chat,
    "  private markPeerReady(",
    "\n  private armReadyTimeout(",
    r'''  private markPeerReady(remotePeerId: string): void {
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
''',
)

replace_between(
    chat,
    "  private async requestHistory(",
    "\n  private async respondHistory(",
    r'''  private async requestHistory(remotePeerId: string): Promise<void> {
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
''',
)

replace_between(
    chat,
    "  private async respondHistory(",
    "\n  private async refreshGroupMembership(",
    r'''  private async respondHistory(remotePeerId: string, request: HistoryRequestWireMessage): Promise<void> {
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
''',
)

replace_between(
    chat,
    "  private async refreshGroupMembership(",
    "\n  private installGroupPeers(",
    r'''  private async refreshGroupMembership(broadcast: boolean): Promise<void> {
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
''',
)

replace_between(
    chat,
    "  private async sendGroupMembership(",
    "\n  private async sendRevocations(",
    r'''  private async sendGroupMembership(remotePeerId: string): Promise<void> {
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
''',
)

replace_between(
    chat,
    "  private async sendProfileUpdate(",
    "\n  private sendToAuthenticatedPeers(",
    r'''  private async sendProfileUpdate(remotePeerId: string): Promise<void> {
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
''',
)

replace_between(
    chat,
    "  private async flushOutbox(",
    "\n  private sendMessageAck(",
    r'''  private async flushOutbox(remotePeerId: string): Promise<void> {
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
''',
)

replace_once(
    chat,
    '      if (record.state !== "completed" && record.direction !== "outgoing") throw new Error("Conecte ao peer para baixar este arquivo.");',
    '      const locallyAvailable = record.direction === "outgoing" ? record.sourcePersisted === true : record.state === "completed";\n      if (!locallyAvailable) throw new Error("Conecte ao peer para baixar este arquivo.");',
)

# 3: Keep binary chunk validation at 256 KiB, but do not apply that same body
# ceiling to full group/profile JSON payloads.
main_rs = "desktop-backend/src/main.rs"
replace_once(
    main_rs,
    "pub(crate) const MAX_ATTACHMENT_CHUNK_BYTES: usize = 256 * 1024;\n",
    "pub(crate) const MAX_ATTACHMENT_CHUNK_BYTES: usize = 256 * 1024;\nconst MAX_HTTP_BODY_BYTES: usize = 4 * 1024 * 1024;\n",
)
replace_once(
    main_rs,
    '''        // O endpoint binário de anexos aceita chunks de até 256 KiB. O limite\n        // global precisa permitir o mesmo tamanho; os handlers JSON continuam\n        // aplicando suas próprias validações de campos e comprimentos.\n        .layer(RequestBodyLimitLayer::new(MAX_ATTACHMENT_CHUNK_BYTES))''',
    '''        // O limite HTTP global também precisa comportar o snapshot JSON completo\n        // de grupos. Chunks de anexos continuam limitados a 256 KiB dentro do\n        // próprio handler `write_chunk`, antes de serem gravados em disco.\n        .layer(RequestBodyLimitLayer::new(MAX_HTTP_BODY_BYTES))''',
)

# 4: refuse locally generated group states that cannot fit the authenticated
# 64 KiB control envelope. This converts a late/silent desync into an immediate,
# user-visible validation error while preserving the 48-member hard cap.
social = "apps/web/src/services/offline/social-storage.ts"
replace_once(
    social,
    "const MAX_GROUP_MEMBERS = 48;\nconst MAX_GROUP_REVOCATIONS = 48;\n",
    "const MAX_GROUP_MEMBERS = 48;\nconst MAX_GROUP_REVOCATIONS = 48;\nconst MAX_GROUP_SYNC_WIRE_BYTES = 60 * 1024;\n",
)
insert_before(
    social,
    "export async function saveLocalGroup(group: LocalGroup): Promise<void> {",
    r'''export function assertLocalGroupSyncBudget(group: LocalGroup): void {
  const members = (group.members ?? []).map(({ avatar: _avatar, ...member }) => member);
  const removedMembers = (group.removedMembers ?? []).map(({ avatar: _avatar, ...member }) => member);
  const projection = {
    version: 2,
    type: "chat.members.snapshot",
    channelId: "00000000-0000-4000-8000-000000000000",
    groupId: group.groupId,
    senderPeerId: group.manifestActorPeerId ?? group.ownerPeerId,
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
    revocations: group.revocations ?? [],
    rendezvousVersion: group.rendezvousVersion ?? 1,
    rendezvousSecret: group.rendezvousSecret ?? group.groupId,
    members,
    timestamp: Date.now(),
    signature: "A".repeat(86),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(projection)).byteLength;
  if (bytes > MAX_GROUP_SYNC_WIRE_BYTES) {
    throw new Error("Este grupo excedeu o orçamento seguro de sincronização P2P. Reduza a imagem do grupo, a quantidade de canais ou identidades/revogações antigas antes de continuar.");
  }
}

''',
)
replace_once(
    social,
    "export async function saveLocalGroup(group: LocalGroup): Promise<void> {\n  const config = await desktopConfig();",
    "export async function saveLocalGroup(group: LocalGroup): Promise<void> {\n  assertLocalGroupSyncBudget(group);\n  const config = await desktopConfig();",
)

# 5 + 6: explicit failed state for unavailable requested attachments and durable
# source tracking for outgoing files.
indexed = "apps/web/src/services/attachments/indexeddb-storage.ts"
replace_once(
    indexed,
    "  direction: AttachmentDirection;\n  manifest: AttachmentManifest;",
    "  direction: AttachmentDirection;\n  sourcePersisted?: boolean;\n  manifest: AttachmentManifest;",
)
replace_once(
    indexed,
    "    return record;\n  }\n\n  async registerOutgoing(\n",
    "    const persisted = { ...record, sourcePersisted: true, updatedAt: new Date().toISOString() };\n    await this.saveRecord(persisted);\n    return persisted;\n  }\n\n  async registerOutgoing(\n",
)
replace_once(
    indexed,
    '      direction: "outgoing",\n      manifest,',
    '      direction: "outgoing",\n      sourcePersisted: false,\n      manifest,',
)
replace_between(
    indexed,
    "  async findCompletedByAttachmentId(",
    "\n  async getBlob(",
    r'''  async findCompletedByAttachmentId(attachmentId: string): Promise<StoredAttachmentRecord | undefined> {
    const records = await getAllByIndex<StoredAttachmentRecord>(OFFLINE_STORES.attachments, "attachmentId", attachmentId);
    return records.find((record) => record.direction === "incoming"
      ? record.state === "completed"
      : record.sourcePersisted === true);
  }
''',
)

desktop_storage = "apps/web/src/services/attachments/desktop-storage.ts"
replace_once(
    desktop_storage,
    "export class DesktopAttachmentStorage extends IndexedDbAttachmentStorage {\n  constructor(private readonly config: DesktopAttachmentBackendConfig) { super(); }",
    "type DesktopAttachmentBackendResolver = () => Promise<DesktopAttachmentBackendConfig>;\n\nexport class DesktopAttachmentStorage extends IndexedDbAttachmentStorage {\n  constructor(private readonly resolveConfig: DesktopAttachmentBackendResolver) { super(); }",
)
replace_between(
    desktop_storage,
    "  override async persistOutgoingSource(\n",
    "\n  override async getBlob(",
    r'''  override async persistOutgoingSource(
    transferId: string,
    channelId: string,
    peerId: string,
    source: Blob,
    manifest: AttachmentManifest,
  ): Promise<StoredAttachmentRecord> {
    const record = await this.registerOutgoing(transferId, channelId, peerId, manifest);
    await this.prepareRustTransfer(transferId, manifest);
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const offset = index * manifest.chunkSize;
      const payload = await source.slice(offset, Math.min(source.size, offset + manifest.chunkSize)).arrayBuffer();
      await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/chunks/${index}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payload,
      });
    }
    const response = await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/finalize`, { method: "POST" });
    const result = await response.json() as { contentHash?: unknown };
    if (typeof result.contentHash !== "string" || result.contentHash.toLowerCase() !== manifest.contentHash.toLowerCase()) {
      throw new Error("Cópia persistente do anexo falhou na verificação SHA-256.");
    }
    const persisted = { ...record, sourcePersisted: true, updatedAt: new Date().toISOString() };
    await this.saveRecord(persisted);
    return persisted;
  }
''',
)
replace_between(
    desktop_storage,
    "  private async request(",
    "\n}\n\nexport async function createAttachmentStorage",
    r'''  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const config = await this.resolveConfig();
    const headers = new Headers(init.headers);
    headers.set("x-risk-desktop-token", config.token);
    const baseUrl = config.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let message = `Backend local retornou HTTP ${response.status}.`;
      try {
        const payload = await response.json() as { message?: unknown };
        if (typeof payload.message === "string") message = payload.message;
      } catch { /* resposta não JSON */ }
      throw new Error(message);
    }
    return response;
  }
''',
)
replace_between(
    desktop_storage,
    "export async function createAttachmentStorage():",
    "\n}",
    r'''export async function createAttachmentStorage(): Promise<IndexedDbAttachmentStorage> {
  const bridge = window.desktop;
  if (!bridge?.getBackendConfig) return new IndexedDbAttachmentStorage();
  return new DesktopAttachmentStorage(async () => {
    const config = await bridge.getBackendConfig();
    return { baseUrl: config.baseUrl.replace(/\/$/, ""), token: config.token };
  });
''',
)

attachment_service = "apps/web/src/services/attachments/attachment-service.ts"
replace_once(
    attachment_service,
    '    const updated = { ...record, state: "waiting" as const, updatedAt: new Date().toISOString() };',
    '    const updated = { ...record, state: "waiting" as const, lastError: undefined, updatedAt: new Date().toISOString() };',
)
replace_between(
    attachment_service,
    "  async download(record: StoredAttachmentRecord): Promise<void> {",
    "\n  async handleControlString(",
    r'''  async download(record: StoredAttachmentRecord): Promise<void> {
    const locallyAvailable = record.direction === "outgoing" ? record.sourcePersisted === true : record.state === "completed";
    if (!locallyAvailable) {
      if (record.direction === "incoming") {
        await this.requestDownload(record);
        return;
      }
      throw new Error("A cópia local deste anexo enviado não está mais disponível. Envie o arquivo novamente.");
    }
    const blob = await this.getBlob(record);
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = sanitizeAttachmentFilename(record.manifest.filename);
      anchor.rel = "noopener";
      anchor.click();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
  }
''',
)
replace_once(
    attachment_service,
    "    const transferId = \"transferId\" in message ? message.transferId : undefined;\n    const outgoing = transferId ? this.outgoing.get(transferId) : undefined;",
    "    if (message.type === \"file.error\" && message.transferId.startsWith(\"request:\")) {\n      await this.markRequestedAttachmentError(peerId, message.transferId.slice(\"request:\".length), message.message);\n      return;\n    }\n\n    const transferId = \"transferId\" in message ? message.transferId : undefined;\n    const outgoing = transferId ? this.outgoing.get(transferId) : undefined;",
)
replace_between(
    attachment_service,
    "  private async serveRequestedAttachment(",
    "\n  private async sendSyncHello(",
    r'''  private async serveRequestedAttachment(peerId: string, attachmentId: string): Promise<void> {
    const capabilities = this.peerCapabilities.get(peerId);
    if (!capabilities?.has("file-transfer-v1") || !this.transport.isTransferChannelOpen(peerId)) {
      await this.sendControl(peerId, { type: "file.error", transferId: `request:${attachmentId}`, code: "transfer_unavailable", message: "O canal de transferência ainda não está disponível.", retryable: true });
      return;
    }
    const record = await this.storage.findAnyByAttachmentId(attachmentId);
    if (!record || record.channelId !== this.channelId) {
      await this.sendControl(peerId, { type: "file.error", transferId: `request:${attachmentId}`, code: "attachment_unavailable", message: "Este peer não possui mais o arquivo solicitado.", retryable: false });
      return;
    }
    let source = this.sourceByAttachment.get(attachmentId);
    if (!source) {
      try {
        source = await this.storage.getBlob(attachmentId, record.manifest) as TransferSource;
      } catch {
        await this.sendControl(peerId, { type: "file.error", transferId: `request:${attachmentId}`, code: "attachment_unavailable", message: "Este peer não possui mais uma cópia local íntegra do arquivo solicitado.", retryable: false });
        return;
      }
    }
    this.sourceByAttachment.set(attachmentId, source);
    const transferId = await this.sender.offer(peerId, source, record.manifest);
    this.outgoing.set(transferId, { peerId, attachmentId });
    await this.storage.registerOutgoing(transferId, this.channelId, peerId, record.manifest);
  }

  private async markRequestedAttachmentError(peerId: string, attachmentId: string, message: string): Promise<void> {
    const record = await this.storage.findAnyByAttachmentId(attachmentId);
    if (!record || record.channelId !== this.channelId || record.peerId !== peerId || record.state === "completed") return;
    const updated = { ...record, state: "failed" as const, lastError: message, updatedAt: new Date().toISOString() };
    await this.storage.saveRecord(updated);
    this.emitRecord(updated);
  }
''',
)
replace_once(
    attachment_service,
    '    const available = records.filter((record) => ids.includes(record.attachmentId) && (record.direction === "outgoing" || record.state === "completed"));',
    '    const available = records.filter((record) => ids.includes(record.attachmentId) && (\n      this.sourceByAttachment.has(record.attachmentId)\n      || (record.direction === "incoming" && record.state === "completed")\n      || (record.direction === "outgoing" && record.sourcePersisted === true)\n    ));',
)
replace_once(
    attachment_service,
    '      if (record.direction !== "outgoing" && record.state !== "completed") continue;',
    '      const available = this.sourceByAttachment.has(record.attachmentId)\n        || (record.direction === "incoming" && record.state === "completed")\n        || (record.direction === "outgoing" && record.sourcePersisted === true);\n      if (!available) continue;',
)
replace_once(
    attachment_service,
    '''        } catch (error) {\n          await this.storage.registerOutgoing(transferId, this.channelId, peerId, manifest);\n          console.warn("Não foi possível manter uma cópia offline completa do anexo enviado.", error);\n        }''',
    '''        } catch (error) {\n          const fallback = await this.storage.registerOutgoing(transferId, this.channelId, peerId, manifest);\n          await this.storage.saveRecord({\n            ...fallback,\n            sourcePersisted: false,\n            lastError: "A transferência foi iniciada, mas a cópia offline local não pôde ser preservada.",\n            updatedAt: new Date().toISOString(),\n          });\n          console.warn("Não foi possível manter uma cópia offline completa do anexo enviado.", error);\n        }''',
)

card = "apps/web/src/components/AttachmentCard.tsx"
replace_once(
    card,
    '  const canPreview = record.state === "completed" || record.direction === "outgoing";',
    '  const locallyAvailable = record.direction === "outgoing" ? record.sourcePersisted === true : record.state === "completed";\n  const canPreview = locallyAvailable;',
)
replace_once(
    card,
    '  const downloadable = record.state === "completed" || record.direction === "outgoing";',
    '  const downloadable = locallyAvailable;',
)

# 7 is implemented by DesktopAttachmentStorage resolving the current sidecar
# config per request and by removing the transient IndexedDB fallback above.

# 8: Call authentication and revocation operations are tied to lifecycleId.
call = "apps/web/src/call.ts"
replace_once(
    call,
    "      onDataMessage: (remotePeerId, data) => {",
    "      onNegotiationError: (remotePeerId, error) => {\n        useCallStore.getState().setError(`Falha ao negociar mídia com ${remotePeerId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);\n      },\n      onDataMessage: (remotePeerId, data) => {",
)
replace_between(
    call,
    "  private async respondAuthChallenge(",
    "\n  private async acceptAuthProof(",
    r'''  private async respondAuthChallenge(remotePeerId: string, message: Partial<Extract<CallAuthMessage, { type: "call.auth.challenge" }>>): Promise<void> {
    const lifecycle = this.lifecycleId;
    const identity = this.identity;
    const transport = this.transport;
    const localPeerId = this.peerId;
    const roomId = this.roomId;
    if (!identity || !transport || typeof message.nonce !== "string" || !localPeerId || !roomId) return;
    const publicProfile = publicIdentity(identity);
    const canonical = this.authCanonical(remotePeerId, message.nonce, publicProfile);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, new TextEncoder().encode(canonical));
    if (!this.isActive(lifecycle) || this.transport !== transport || this.identity !== identity || this.peerId !== localPeerId || this.roomId !== roomId) return;
    const proof: CallAuthMessage = { version: 1, type: "call.auth.proof", identity: publicProfile, nonce: message.nonce, timestamp: Date.now(), capabilities: LOCAL_RISK_CAPABILITIES, signature: bytesToBase64Url(new Uint8Array(signature)) };
    transport.sendData(JSON.stringify(proof), remotePeerId);
  }
''',
)
replace_between(
    call,
    "  private async acceptAuthProof(",
    "\n  private async handleGroupRevocationMessage(",
    r'''  private async acceptAuthProof(remotePeerId: string, message: Partial<Extract<CallAuthMessage, { type: "call.auth.proof" }>>): Promise<void> {
    const lifecycle = this.lifecycleId;
    const transport = this.transport;
    const identity = this.identity;
    const expectedNonce = this.authChallenges.get(remotePeerId);
    const remoteIdentity = message.identity;
    if (!transport || !identity || !expectedNonce || message.nonce !== expectedNonce || !remoteIdentity || typeof message.signature !== "string" || !validRiskPeerCapabilities(message.capabilities) || !compatibleCallPeer(message.capabilities)) return;
    if (remoteIdentity.peerId !== remotePeerId || !/^[A-Za-z0-9_-]{8,128}$/.test(remoteIdentity.peerId) || remoteIdentity.displayName.trim().length < 2 || remoteIdentity.displayName.length > 80 || (remoteIdentity.avatar !== undefined && !validAvatarDataUrl(remoteIdentity.avatar))) return;
    const trusted = this.trustedPeers.get(remoteIdentity.peerId) ?? this.revokedPeers.get(remoteIdentity.peerId);
    if (!trusted || JSON.stringify(trusted.publicKey) !== JSON.stringify(remoteIdentity.publicKey)) return;
    try {
      const key = await crypto.subtle.importKey("jwk", trusted.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const canonical = this.authCanonical(remotePeerId, expectedNonce, remoteIdentity, message.capabilities);
      const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlToArrayBuffer(message.signature), new TextEncoder().encode(canonical));
      if (!valid || !this.isActive(lifecycle) || this.transport !== transport || this.identity !== identity || this.authChallenges.get(remotePeerId) !== expectedNonce) return;
      this.authChallenges.delete(remotePeerId);
      const timer = this.authTimers.get(remotePeerId); if (timer) clearTimeout(timer);
      this.authTimers.delete(remotePeerId);
      this.remoteIdentityPeerIds.set(remotePeerId, remoteIdentity.peerId);
      this.authenticatedPeers.add(remotePeerId);
      if (this.revokedPeers.has(remoteIdentity.peerId)) {
        this.pendingRevokedPeers.delete(remotePeerId);
        this.revocationOnlyPeers.add(remotePeerId);
        transport.revokePeerMedia(remotePeerId);
        useCallStore.getState().remove(remotePeerId);
        this.pendingPeerStates.delete(remotePeerId);
        await this.sendCallRevocations(remotePeerId, remoteIdentity.peerId);
        return;
      }
      const participant = useCallStore.getState().participants[remotePeerId] ?? placeholderParticipant(remotePeerId);
      useCallStore.getState().upsert({ ...participant, displayName: remoteIdentity.displayName, avatar: remoteIdentity.avatar });
      await transport.authorizePeerMedia(remotePeerId);
      if (!this.isActive(lifecycle) || this.transport !== transport) return;
      const pendingState = this.pendingPeerStates.get(remotePeerId);
      if (pendingState) {
        this.pendingPeerStates.delete(remotePeerId);
        this.applyRemotePeerState(remotePeerId, pendingState);
      }
    } catch { /* prova externa inválida */ }
  }
''',
)
replace_between(
    call,
    "  private async handleGroupRevocationMessage(",
    "\n  private async sendCallRevocations(",
    r'''  private async handleGroupRevocationMessage(remotePeerId: string, raw: string): Promise<void> {
    const lifecycle = this.lifecycleId;
    const groupId = this.groupId;
    const identity = this.identity;
    if (!groupId || !identity) return;
    if (new TextEncoder().encode(raw).byteLength > 64 * 1024) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Partial<CallGroupRevocationMessage>;
    if (message.version !== 1 || message.type !== "call.group.revocation" || !validGroupRevocationCertificate(message.certificate)) return;
    if (message.certificate.groupId !== groupId || !(await applyGroupRevocationCertificate(message.certificate))) return;
    if (!this.isActive(lifecycle) || this.groupId !== groupId || this.identity !== identity) return;
    if (message.certificate.targetPeerId === identity.peerId) {
      await this.cleanup();
      return;
    }
    await this.refreshGroupSecurity();
  }
''',
)
replace_between(
    call,
    "  private async refreshGroupSecurity(",
    "\n  private rejectIncompatibleCallPeer(",
    r'''  private async refreshGroupSecurity(): Promise<void> {
    const lifecycle = this.lifecycleId;
    const groupId = this.groupId;
    if (!groupId) return;
    const group = (await loadLocalGroups()).find((item) => item.groupId === groupId);
    if (!group || !this.isActive(lifecycle) || this.groupId !== groupId) return;
    this.trustedPeers.clear();
    this.revokedPeers.clear();
    (group.members ?? []).forEach((peer) => this.trustedPeers.set(peer.peerId, peer));
    (group.removedMembers ?? []).forEach((peer) => this.revokedPeers.set(peer.peerId, peer));
    this.revocations = (group.revocations ?? []).filter(validGroupRevocationCertificate);

    for (const [remotePeerId, identityPeerId] of [...this.remoteIdentityPeerIds]) {
      if (!this.isActive(lifecycle)) return;
      if (this.revokedPeers.has(identityPeerId)) {
        this.revocationOnlyPeers.add(remotePeerId);
        this.pendingPeerStates.delete(remotePeerId);
        this.transport?.revokePeerMedia(remotePeerId);
        useCallStore.getState().remove(remotePeerId);
        await this.sendCallRevocations(remotePeerId, identityPeerId);
      } else if (!this.trustedPeers.has(identityPeerId)) {
        this.authenticatedPeers.delete(remotePeerId);
        this.remoteIdentityPeerIds.delete(remotePeerId);
        this.transport?.revokePeerMedia(remotePeerId);
        useCallStore.getState().remove(remotePeerId);
        await this.transport?.disconnect(remotePeerId);
      }
    }
    if (!this.isActive(lifecycle)) return;
    const nextRendezvousId = this.roomId ? groupRendezvousId(group, "voice", this.roomId) : undefined;
    const signaling = this.signaling;
    const peerId = this.peerId;
    if (nextRendezvousId && this.rendezvousId && nextRendezvousId !== this.rendezvousId && signaling && peerId) {
      this.rendezvousId = nextRendezvousId;
      await signaling.connect(nextRendezvousId, peerId);
      if (!this.isActive(lifecycle) || this.signaling !== signaling) return;
    }
  }
''',
)

# 9 + 10: explicit renegotiation errors for callers/events and bounded
# backpressure waits on the transfer DataChannel.
rtc = "packages/rtc/src/index.ts"
replace_once(
    rtc,
    "  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;\n  onDataMessage?(peerId: string, data: string): void;",
    "  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;\n  onNegotiationError?(peerId: string, error: unknown): void;\n  onDataMessage?(peerId: string, data: string): void;",
)
replace_once(
    rtc,
    "const TRANSFER_LOW_WATER_MARK_BYTES = 1 * 1024 * 1024;\n",
    "const TRANSFER_LOW_WATER_MARK_BYTES = 1 * 1024 * 1024;\nconst TRANSFER_BUFFER_WAIT_TIMEOUT_MS = 15_000;\n",
)
replace_between(
    rtc,
    "  async waitForTransferBufferedAmountLow(",
    "\n  async restartIce(",
    r'''  async waitForTransferBufferedAmountLow(peerId: string, threshold = TRANSFER_LOW_WATER_MARK_BYTES): Promise<void> {
    const channel = this.requirePeer(peerId).transferDataChannel;
    if (!channel || channel.readyState !== "open") throw new Error(`Canal ${TRANSFER_CHANNEL_LABEL} indisponível para ${peerId}.`);
    if (channel.bufferedAmount <= threshold) return;
    channel.bufferedAmountLowThreshold = Math.max(0, threshold);
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClosed);
        channel.removeEventListener("error", onClosed);
      };
      const onLow = () => { cleanup(); resolve(); };
      const onClosed = () => { cleanup(); reject(new Error(`Canal ${TRANSFER_CHANNEL_LABEL} foi fechado durante a transferência.`)); };
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Canal ${TRANSFER_CHANNEL_LABEL} permaneceu congestionado por mais de ${TRANSFER_BUFFER_WAIT_TIMEOUT_MS / 1000}s.`));
      }, TRANSFER_BUFFER_WAIT_TIMEOUT_MS);
      channel.addEventListener("bufferedamountlow", onLow, { once: true });
      channel.addEventListener("close", onClosed, { once: true });
      channel.addEventListener("error", onClosed, { once: true });
    });
  }
''',
)
replace_once(
    rtc,
    "      void this.negotiateIfNeeded(peerId, entry);\n    };",
    "      void this.negotiateIfNeeded(peerId, entry).catch((error) => {\n        logger.warn(\"WebRTC negotiationneeded failed\", { peerId, error: String(error) });\n        this.events.onNegotiationError?.(peerId, error);\n      });\n    };",
)
replace_once(
    rtc,
    '''    } catch (error) {\n      if (!iceRestart) entry.needsNegotiation = true;\n      logger.warn("WebRTC renegotiation failed", { peerId, error: String(error) });\n    } finally { entry.makingOffer = false; }''',
    '''    } catch (error) {\n      if (!iceRestart) entry.needsNegotiation = true;\n      logger.warn("WebRTC renegotiation failed", { peerId, error: String(error) });\n      throw error;\n    } finally { entry.makingOffer = false; }''',
)

# 11: never hash SHA256SUMS.txt while it is being produced.
release = ".github/workflows/release.yml"
replace_once(
    release,
    "      - run: find artifacts -type f -print0 | sort -z | xargs -0 sha256sum > artifacts/SHA256SUMS.txt",
    "      - name: Generate release checksums\n        working-directory: artifacts\n        run: find . -type f ! -name SHA256SUMS.txt -printf '%P\\0' | sort -z | xargs -0 sha256sum > SHA256SUMS.txt",
)

# 12a: IndexedDB writes resolve only after the transaction commits. Also close
# old handles on versionchange and report blocked upgrades instead of hanging.
database = "apps/web/src/services/offline/database.ts"
replace_once(
    database,
    "    request.onsuccess = () => resolve(request.result);\n    request.onerror = () => reject(request.error ?? new Error(\"IndexedDB indisponível.\"));",
    "    request.onsuccess = () => {\n      const database = request.result;\n      database.onversionchange = () => database.close();\n      resolve(database);\n    };\n    request.onblocked = () => reject(new Error(\"Atualização do armazenamento local bloqueada por outra janela do Risk.\"));\n    request.onerror = () => reject(request.error ?? new Error(\"IndexedDB indisponível.\"));",
)
replace_once(
    database,
    "    const transaction = database.transaction(storeName, \"readwrite\");\n    const store = transaction.objectStore(storeName);",
    "    const transaction = database.transaction(storeName, \"readwrite\");\n    const done = transactionDone(transaction);\n    const store = transaction.objectStore(storeName);",
)
replace_once(
    database,
    "    await transactionDone(transaction);\n  } finally { database.close(); }\n}",
    "    await done;\n  } finally { database.close(); }\n}",
)
replace_between(
    database,
    "async function withStore<T>(",
    "\n}",
    r'''async function withStore<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const database = await openRiskDatabase();
  try {
    const transaction = database.transaction(storeName, mode);
    const done = transactionDone(transaction);
    const result = await asyncRequest(operation(transaction.objectStore(storeName))) as T;
    await done;
    return result;
  } finally { database.close(); }
''',
)

# 12b: remove CSP-blocked duplicate fullscreen style injection. The exact rules
# already live in call-workspace.css and remain unchanged.
preload = "apps/desktop/src/preload.cts"
replace_once(preload, 'const FULLSCREEN_STYLE_ID = "risk-native-stream-fullscreen-style";\n', "")
replace_between(
    preload,
    "function installNativeStreamFullscreenStyle(): void {",
    "\nfunction closestFromEventTarget(",
    "",
)
replace_once(preload, "  installNativeStreamFullscreenStyle();\n\n", "")

# 12c: make the protocol package require real tests and add focused regressions.
protocol_package = "packages/protocol/package.json"
replace_once(protocol_package, '"test":"vitest run --passWithNoTests"', '"test":"vitest run"')

write(
    "packages/protocol/src/attachments.test.ts",
    r'''import { describe, expect, it } from "vitest";
import {
  RISK_ATTACHMENT_PROTOCOL_VERSION,
  sanitizeAttachmentFilename,
  validateAttachmentManifest,
  type AttachmentManifest,
} from "./attachments";

function manifest(overrides: Partial<AttachmentManifest> = {}): AttachmentManifest {
  return {
    protocolVersion: RISK_ATTACHMENT_PROTOCOL_VERSION,
    id: "a".repeat(64),
    senderPeerId: "peer_12345678",
    filename: "arquivo.zip",
    mimeType: "application/zip",
    kind: "archive",
    size: 64,
    contentHash: "a".repeat(64),
    chunkSize: 64,
    chunkCount: 1,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("attachment protocol validation", () => {
  it("accepts a bounded valid manifest", () => {
    expect(validateAttachmentManifest(manifest())).toEqual([]);
  });

  it("rejects invalid hashes and chunk counts", () => {
    expect(validateAttachmentManifest(manifest({ contentHash: "nope", chunkCount: -1 }))).toEqual(
      expect.arrayContaining(["invalid_content_hash", "invalid_chunk_count"]),
    );
  });

  it("removes path traversal and reserved filename characters", () => {
    expect(sanitizeAttachmentFilename("../../bad<name>.exe")).toBe("bad_name_.exe");
  });
});
''',
)

write(
    "apps/web/src/services/attachments/attachment-service.test.ts",
    r'''import { describe, expect, it } from "vitest";
import type { AttachmentManifest } from "@risk/protocol/attachments";
import type { MeshWebRTCTransport } from "@risk/rtc";
import { AttachmentService, type AttachmentStorage } from "./attachment-service";
import type { StoredAttachmentRecord } from "./indexeddb-storage";

const attachmentId = "a".repeat(64);
const manifest: AttachmentManifest = {
  protocolVersion: 1,
  id: attachmentId,
  channelId: "channel_12345678",
  senderPeerId: "peer_12345678",
  filename: "arquivo.bin",
  mimeType: "application/octet-stream",
  kind: "other",
  size: 64,
  contentHash: attachmentId,
  chunkSize: 64,
  chunkCount: 1,
  createdAt: new Date(0).toISOString(),
};

function record(): StoredAttachmentRecord {
  return {
    recordId: `channel_12345678:${attachmentId}:sync:peer_12345678:${attachmentId}`,
    attachmentId,
    transferId: `sync:peer_12345678:${attachmentId}`,
    channelId: "channel_12345678",
    peerId: "peer_12345678",
    direction: "incoming",
    manifest,
    state: "waiting",
    bytesTransferred: 0,
    totalBytes: 64,
    retryCount: 0,
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  };
}

describe("AttachmentService request errors", () => {
  it("marks a synchronized attachment as failed when the source no longer has it", async () => {
    let current = record();
    const storage: AttachmentStorage = {
      prepare: async () => undefined,
      hasChunk: async () => false,
      writeChunk: async () => undefined,
      finalize: async () => ({ contentHash: attachmentId }),
      persistOutgoingSource: async () => current,
      registerOutgoing: async () => current,
      registerSyncedMetadata: async () => current,
      updateProgress: async () => current,
      listChannel: async () => [current],
      findByTransferId: async () => current,
      findAnyByAttachmentId: async () => current,
      findCompletedByAttachmentId: async () => undefined,
      getBlob: async () => new Blob(),
      saveRecord: async (next) => { current = next; },
    };
    const transport = {
      sendData: () => 1,
      sendTransferData: () => 1,
      waitForTransferBufferedAmountLow: async () => undefined,
      getTransferBufferedAmount: () => 0,
      isTransferChannelOpen: () => true,
      ensureTransferChannel: () => undefined,
    } as unknown as MeshWebRTCTransport;
    const service = new AttachmentService(transport, "channel_12345678", "self_12345678", () => ["peer_12345678"], storage);

    await service.handleControlString("peer_12345678", JSON.stringify({
      type: "file.error",
      transferId: `request:${attachmentId}`,
      code: "attachment_unavailable",
      message: "Arquivo removido no peer remoto.",
      retryable: false,
    }));

    expect(current.state).toBe("failed");
    expect(current.lastError).toBe("Arquivo removido no peer remoto.");
  });
});
''',
)

write(
    "apps/web/src/services/offline/social-storage-budget.test.ts",
    r'''import { describe, expect, it } from "vitest";
import { assertLocalGroupSyncBudget, type LocalGroup } from "./social-storage";

const identity = {
  peerId: "peer_12345678",
  displayName: "Samuel",
  publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) },
};

function group(avatar?: string): LocalGroup {
  return {
    groupId: "group_12345678",
    name: "Grupo",
    avatar,
    channels: [{ id: "channel_12345678", name: "geral", kind: "text" }],
    ownerPeerId: identity.peerId,
    membershipVersion: 1,
    manifestVersion: 1,
    manifestActorPeerId: identity.peerId,
    manifestOperationId: "operation_12345678",
    administratorEpoch: 1,
    administratorPeerIds: [],
    administratorGrants: [],
    removedPeerIds: [],
    removedMembers: [],
    revocations: [],
    rendezvousVersion: 1,
    rendezvousSecret: "secret_12345678",
    members: [identity],
    joinedAt: 1,
  };
}

describe("group sync budget", () => {
  it("allows a normal group snapshot", () => {
    expect(() => assertLocalGroupSyncBudget(group())).not.toThrow();
  });

  it("rejects a state that cannot fit in one safe control envelope", () => {
    expect(() => assertLocalGroupSyncBudget(group(`data:image/png;base64,${"A".repeat(70 * 1024)}`))).toThrow(/orçamento seguro/);
  });
});
''',
)

print("Audit patch prepared. Changed files:")
for path in changed:
    print(f" - {path}")
if not changed:
    print(" - none")
