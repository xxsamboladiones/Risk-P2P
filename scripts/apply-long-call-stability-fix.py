from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"anchor not found: {label}")
    return source.replace(old, new, 1)

# --- Supabase signaling: keep presence stable across transient reconnects and reject stale generations.
path = Path("apps/web/src/services/supabase/signaling.ts")
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    'const CLIENT_VERSION = import.meta.env.VITE_RISK_APP_VERSION ?? "0.2.0";\n',
    'const CLIENT_VERSION = import.meta.env.VITE_RISK_APP_VERSION ?? "0.2.0";\nconst PRESENCE_LEAVE_GRACE_MS = 10_000;\nconst SIGNALING_MAX_AGE_MS = 30_000;\nconst SIGNALING_FUTURE_SKEW_MS = 10_000;\nconst SESSION_TIMESTAMP_TOLERANCE_MS = 1_500;\n',
    "signaling constants",
)
source = replace_once(
    source,
    '  private reconnectAttempts = 0;\n',
    '  private reconnectAttempts = 0;\n  private sessionStartedAt = 0;\n  private readonly missingPeers = new Set<string>();\n  private readonly peerLeaveTimers = new Map<string, ReturnType<typeof setTimeout>>();\n  private readonly peerDepartedAt = new Map<string, number>();\n',
    "signaling fields",
)
source = replace_once(
    source,
    '    this.disconnecting = false;\n    this.setStatus("connecting");\n',
    '    this.disconnecting = false;\n    this.sessionStartedAt = Date.now();\n    this.missingPeers.clear();\n    this.peerDepartedAt.clear();\n    this.peerLeaveTimers.forEach((timer) => clearTimeout(timer));\n    this.peerLeaveTimers.clear();\n    this.setStatus("connecting");\n',
    "connect session start",
)
source = source.replace('await activeChannel.track({ peerId, joinedAt: Date.now(), clientVersion: CLIENT_VERSION });', 'await activeChannel.track({ peerId, joinedAt: this.sessionStartedAt, clientVersion: CLIENT_VERSION });')
source = source.replace('await channel.track({ peerId: this.peerId!, joinedAt: Date.now(), clientVersion: CLIENT_VERSION });', 'await channel.track({ peerId: this.peerId!, joinedAt: this.sessionStartedAt, clientVersion: CLIENT_VERSION });')
source = replace_once(
    source,
    '    this.reconnectAttempts = 0;\n    const channel = this.channel;\n',
    '    this.reconnectAttempts = 0;\n    this.peerLeaveTimers.forEach((timer) => clearTimeout(timer));\n    this.peerLeaveTimers.clear();\n    this.missingPeers.clear();\n    this.peerDepartedAt.clear();\n    const channel = this.channel;\n',
    "disconnect timers",
)
source = replace_once(
    source,
    '    this.channelName = undefined;\n    this.setStatus("disconnected");\n',
    '    this.channelName = undefined;\n    this.sessionStartedAt = 0;\n    this.setStatus("disconnected");\n',
    "disconnect session reset",
)
old_reconcile = '''  private reconcilePresence(): void {
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
'''
new_reconcile = '''  private reconcilePresence(): void {
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

    for (const [peerId, peer] of next) {
      const pendingLeave = this.peerLeaveTimers.get(peerId);
      if (pendingLeave) clearTimeout(pendingLeave);
      this.peerLeaveTimers.delete(peerId);
      this.missingPeers.delete(peerId);

      const existing = this.presencePeers.get(peerId);
      if (!existing) {
        this.presencePeers.set(peerId, peer);
        this.log("peer joined", peerId);
        this.emit("peerJoined", peer);
        continue;
      }

      // joinedAt identifica uma sessão lógica do peer. reconnects internos do
      // Supabase preservam o valor; uma nova instância do Risk recebe outro.
      if (Math.abs(existing.joinedAt - peer.joinedAt) > SESSION_TIMESTAMP_TOLERANCE_MS) {
        this.peerDepartedAt.set(peerId, Math.max(Date.now(), peer.joinedAt));
        this.presencePeers.set(peerId, peer);
        this.log("peer session replaced", peerId);
        this.emit("peerLeft", peerId);
        this.emit("peerJoined", peer);
        continue;
      }
      this.presencePeers.set(peerId, peer);
    }

    for (const peerId of this.presencePeers.keys()) {
      if (next.has(peerId) || this.peerLeaveTimers.has(peerId)) continue;
      this.missingPeers.add(peerId);
      const timer = setTimeout(() => {
        this.peerLeaveTimers.delete(peerId);
        if (!this.missingPeers.delete(peerId)) return;
        const peer = this.presencePeers.get(peerId);
        if (!peer) return;
        this.presencePeers.delete(peerId);
        this.peerDepartedAt.set(peerId, Date.now());
        this.log("peer left after grace", peerId);
        this.emit("peerLeft", peerId);
      }, PRESENCE_LEAVE_GRACE_MS);
      this.peerLeaveTimers.set(peerId, timer);
    }
  }
'''
source = replace_once(source, old_reconcile, new_reconcile, "reconcilePresence")
old_accept = '''  private acceptMessage(message: OfferMessage | AnswerMessage | IceCandidateMessage | PeerStateMessage): boolean {
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
'''
new_accept = '''  private acceptMessage(message: OfferMessage | AnswerMessage | IceCandidateMessage | PeerStateMessage): boolean {
    if (!this.peerId || !this.roomId || message.roomId !== this.roomId || message.fromPeerId === this.peerId) return false;
    if (message.targetPeerId !== undefined && message.targetPeerId !== this.peerId) return false;
    const now = Date.now();
    if (!Number.isFinite(message.timestamp) || message.timestamp < now - SIGNALING_MAX_AGE_MS || message.timestamp > now + SIGNALING_FUTURE_SKEW_MS) return false;

    if (!this.presencePeers.has(message.fromPeerId)) this.reconcilePresence();
    const presentPeer = this.presencePeers.get(message.fromPeerId);
    if (presentPeer && message.timestamp + SESSION_TIMESTAMP_TOLERANCE_MS < presentPeer.joinedAt) {
      this.log("discarding signaling from older peer session", message.fromPeerId);
      return false;
    }
    const lastDeparture = this.peerDepartedAt.get(message.fromPeerId);
    if (!presentPeer && lastDeparture && message.timestamp <= lastDeparture) {
      this.log("discarding signaling sent before peer departure", message.fromPeerId);
      return false;
    }

    if (!presentPeer) {
      const targetedWebRtcMessage = message.targetPeerId === this.peerId
        && (message.type === "webrtc.offer" || message.type === "webrtc.answer" || message.type === "webrtc.ice-candidate");
      if (!targetedWebRtcMessage) return false;
      this.log("accepting fresh WebRTC signaling before presence sync", message.fromPeerId);
    }

    this.pruneCaches();
    if (this.processedMessageIds.has(message.messageId)) return false;
    if (!this.withinRateLimit(message.fromPeerId, message.type)) return false;
    this.processedMessageIds.set(message.messageId, now);
    return true;
  }
'''
source = replace_once(source, old_accept, new_accept, "acceptMessage")
path.write_text(source, encoding="utf-8")

# --- RTC: serialize remote SDP operations and recover one peer if Chromium detects an m-line generation mismatch.
path = Path("packages/rtc/src/index.ts")
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    '  onNegotiationError?(peerId: string, error: unknown): void;\n',
    '  onNegotiationError?(peerId: string, error: unknown): void;\n  onPeerReset?(peerId: string): void;\n',
    "transport reset callback",
)
source = replace_once(
    source,
    '  transferDataChannel?: RTCDataChannel;\n};\n',
    '  transferDataChannel?: RTCDataChannel;\n  initiator: boolean;\n  descriptionChain: Promise<void>;\n};\n',
    "peer entry fields",
)
source = replace_once(
    source,
    '    if (initiator) entry.canNegotiate = true;\n',
    '    if (initiator) { entry.canNegotiate = true; entry.initiator = true; }\n',
    "remember initiator",
)
source = replace_once(
    source,
    '      pendingIceCandidates: [],\n    };\n',
    '      pendingIceCandidates: [],\n      initiator: false,\n      descriptionChain: Promise.resolve(),\n    };\n',
    "peer entry initialization",
)
old_accept_desc = '''  private async acceptDescription(peerId: string, description: RTCSessionDescriptionInit): Promise<void> {
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
'''
new_accept_desc = '''  private async acceptDescription(peerId: string, description: RTCSessionDescriptionInit): Promise<void> {
    const entry = this.peers.get(peerId) ?? this.createPeer(peerId);
    const operation = entry.descriptionChain.then(async () => {
      if (this.peers.get(peerId) !== entry) return;
      await this.acceptDescriptionNow(peerId, entry, description);
    });
    entry.descriptionChain = operation.catch(() => undefined);
    await operation;
  }

  private async acceptDescriptionNow(peerId: string, entry: PeerEntry, description: RTCSessionDescriptionInit): Promise<void> {
    const { pc } = entry;
    const readyForOffer = !entry.makingOffer && (pc.signalingState === "stable" || entry.settingRemoteAnswer);
    const offerCollision = description.type === "offer" && !readyForOffer;
    const polite = this.localPeerId > peerId;
    entry.ignoreOffer = !polite && offerCollision;
    if (entry.ignoreOffer) return;
    entry.settingRemoteAnswer = description.type === "answer";
    try {
      try {
        if (offerCollision && pc.signalingState !== "stable") {
          await Promise.all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(description)]);
        } else {
          await pc.setRemoteDescription(description);
        }
      } catch (error) {
        if (description.type === "offer" && isMLineOrderMismatch(error) && this.peers.get(peerId) === entry) {
          await this.recoverPeerFromMLineMismatch(peerId, entry, description);
          return;
        }
        throw error;
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

  private async recoverPeerFromMLineMismatch(peerId: string, entry: PeerEntry, offer: RTCSessionDescriptionInit): Promise<void> {
    logger.warn("Resetting one WebRTC peer after stale SDP m-line order", { peerId });
    const initiator = entry.initiator;
    const hadTransferChannel = Boolean(entry.transferDataChannel);
    this.disposePeerEntry(peerId, entry);
    const replacement = this.createPeer(peerId);
    replacement.initiator = initiator;
    replacement.canNegotiate = true;
    if (this.events.onDataMessage && !replacement.dataChannel) {
      this.bindControlDataChannel(peerId, replacement, replacement.pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true }));
    }
    if (hadTransferChannel && this.events.onTransferMessage && !replacement.transferDataChannel) {
      this.bindTransferDataChannel(peerId, replacement, replacement.pc.createDataChannel(TRANSFER_CHANNEL_LABEL, { ordered: true }));
    }
    this.events.onPeerReset?.(peerId);
    await replacement.pc.setRemoteDescription(offer);
    await this.flushPendingIce(replacement);
    replacement.needsNegotiation = false;
    const answer = await replacement.pc.createAnswer();
    await replacement.pc.setLocalDescription(answer);
    if (replacement.pc.localDescription) await this.events.sendAnswer(peerId, replacement.pc.localDescription.toJSON());
  }

  private disposePeerEntry(peerId: string, entry: PeerEntry): void {
    if (this.peers.get(peerId) === entry) this.peers.delete(peerId);
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onnegotiationneeded = null;
    entry.pc.onconnectionstatechange = null;
    entry.pendingIceCandidates.length = 0;
    entry.dataChannel?.close();
    entry.transferDataChannel?.close();
    entry.pc.close();
    this.mediaAuthorizedPeers.delete(peerId);
    const pendingStreams = this.pendingRemoteStreams.get(peerId);
    pendingStreams?.forEach((stream) => stream.getTracks().forEach((track) => { track.enabled = false; }));
    this.pendingRemoteStreams.delete(peerId);
    const activeStreams = this.activeRemoteStreams.get(peerId);
    activeStreams?.forEach((stream) => stream.getTracks().forEach((track) => { track.enabled = false; }));
    this.activeRemoteStreams.delete(peerId);
    this.previousOutboundBytes.delete(peerId);
    const timer = this.disconnectedTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.disconnectedTimers.delete(peerId);
  }
'''
source = replace_once(source, old_accept_desc, new_accept_desc, "acceptDescription")
source = replace_once(
    source,
    'export function defaultPeerState(): PeerState { return { microphone: true, camera: false, screenShare: false }; }\n',
    'function isMLineOrderMismatch(error: unknown): boolean {\n  if (!(error instanceof DOMException) || error.name !== "InvalidAccessError") return false;\n  const message = error.message.toLocaleLowerCase();\n  return message.includes("order of m-lines") && message.includes("previous offer/answer");\n}\n\nexport function defaultPeerState(): PeerState { return { microphone: true, camera: false, screenShare: false }; }\n',
    "m-line helper",
)
path.write_text(source, encoding="utf-8")

# --- Call UI: keep the last authenticated profile while the peer connection is rebuilt, but require auth again for media.
path = Path("apps/web/src/call.ts")
source = path.read_text(encoding="utf-8")
anchor = '''      onNegotiationError: (remotePeerId, error) => {
        useCallStore.getState().setError(`Falha ao negociar mídia com ${remotePeerId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      },
'''
replacement = '''      onPeerReset: (remotePeerId) => {
        this.authenticatedPeers.delete(remotePeerId);
        this.remoteIdentityPeerIds.delete(remotePeerId);
        this.pendingPeerStates.delete(remotePeerId);
        this.authChallenges.delete(remotePeerId);
        const timer = this.authTimers.get(remotePeerId); if (timer) clearTimeout(timer);
        this.authTimers.delete(remotePeerId);
        const store = useCallStore.getState();
        const participant = store.participants[remotePeerId] ?? placeholderParticipant(remotePeerId);
        Object.values(participant.streams).forEach((stream) => stream.getTracks().forEach((track) => { track.enabled = false; }));
        // Preserva nome/avatar autenticados na UI durante a recuperação, mas o
        // transporte bloqueia mídia até uma nova prova ECDSA pelo DataChannel.
        store.upsert({ ...participant, streams: {}, connection: "connecting" });
      },
      onNegotiationError: (remotePeerId, error) => {
        useCallStore.getState().setError(`Falha ao negociar mídia com ${remotePeerId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      },
'''
source = replace_once(source, anchor, replacement, "call peer reset")
path.write_text(source, encoding="utf-8")

# --- RTC regression test: a stale-generation m-line offer rebuilds only that peer and answers instead of killing the call.
path = Path("packages/rtc/src/index.test.ts")
source = path.read_text(encoding="utf-8")
source = replace_once(
    source,
    '  static addedTracks: MediaStreamTrack[] = [];\n',
    '  static addedTracks: MediaStreamTrack[] = [];\n  static failMLineOrderOnce = false;\n',
    "test fail flag",
)
source = replace_once(
    source,
    '''  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = descriptionWithJson(description);
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
''',
    '''  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === "offer" && FakePeerConnection.failMLineOrderOnce) {
      FakePeerConnection.failMLineOrderOnce = false;
      throw new DOMException("Failed to set remote offer sdp: The order of m-lines in subsequent offer doesn't match order from previous offer/answer.", "InvalidAccessError");
    }
    this.remoteDescription = descriptionWithJson(description);
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }
''',
    "test remote description error",
)
source = replace_once(
    source,
    '    FakePeerConnection.addedTracks = [];\n',
    '    FakePeerConnection.addedTracks = [];\n    FakePeerConnection.failMLineOrderOnce = false;\n',
    "test reset flag",
)
insert_before = '''  it("abre um DataChannel por peer e entrega mensagens sem servidor", async () => {
'''
new_test = '''  it("recria somente o peer quando uma offer antiga viola a ordem de m-lines", async () => {
    const callbacks = events();
    const peerId = "00000000-0000-4000-8000-000000000002";
    const transport = new MeshWebRTCTransport("00000000-0000-4000-8000-000000000001", [], callbacks);
    await transport.connect(peerId, false);
    FakePeerConnection.failMLineOrderOnce = true;

    await transport.acceptOffer(peerId, { type: "offer", sdp: "stale-generation-offer" });

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(callbacks.sendAnswer).toHaveBeenCalledOnce();
    expect(transport.getDiagnostics()).toHaveLength(1);
  });

'''
source = replace_once(source, insert_before, new_test + insert_before, "rtc recovery test")
path.write_text(source, encoding="utf-8")
