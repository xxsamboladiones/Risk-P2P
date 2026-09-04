import {
  MAX_GROUP_SYNC_MEMBERS,
  MAX_GROUP_SYNC_REVOCATIONS,
  MAX_WIRE_BYTES,
  base64UrlToArrayBuffer,
  bytesToBase64Url,
  canonicalGroupMembership,
  canonicalProfileUpdate,
  canonicalSignedMessage,
  type GroupMembersWireMessage,
  type ProfileUpdateWireMessage,
  type SignedChatWireMessage,
} from "./MessageProtocol";
import {
  getOrCreateLocalIdentity,
  canonicalGroupRevocation,
  groupRendezvousId,
  loadLocalGroups,
  mergeLocalGroupManifest,
  sameLocalGroupManifestState,
  updateKnownPeerProfile,
  validGroupRevocationCertificate,
  verifyGroupRevocationCertificate,
  type GroupRevocationCertificate,
  type LocalGroup,
  type LocalIdentity,
  type PublicPeerIdentity,
} from "../services/offline/social-storage";

export type InferredGroupSecurity = {
  groupId: string;
  identity: LocalIdentity;
  trustedPeers: PublicPeerIdentity[];
  revokedPeers: PublicPeerIdentity[];
  revocations: GroupRevocationCertificate[];
  rendezvousId: string;
};

export type GroupPeerTransitions = {
  revokedPeerIds: string[];
  unknownPeerIds: string[];
};

export type AcceptedGroupMembership = {
  merged: LocalGroup;
  shouldReply: boolean;
};

export class GroupChatService {
  private readonly trusted = new Map<string, PublicPeerIdentity>();
  private readonly revoked = new Map<string, PublicPeerIdentity>();
  private readonly names = new Map<string, string>();
  private readonly verifyKeys = new Map<string, Promise<CryptoKey>>();
  private certificates: GroupRevocationCertificate[] = [];

  configure(
    identity: LocalIdentity | undefined,
    trustedPeers: PublicPeerIdentity[],
    revokedPeers: PublicPeerIdentity[],
    revocations: GroupRevocationCertificate[],
  ): void {
    const active = identity
      ? trustedPeers.filter((peer) => peer.peerId !== identity.peerId)
      : [...trustedPeers];
    if (identity) {
      active.push({
        peerId: identity.peerId,
        publicKey: identity.publicKey,
        displayName: identity.displayName,
        avatar: identity.avatar,
      });
    }
    this.install(active, revokedPeers, revocations, []);
  }

  reset(): void {
    this.trusted.clear();
    this.revoked.clear();
    this.names.clear();
    this.verifyKeys.clear();
    this.certificates = [];
  }

  install(
    activePeers: PublicPeerIdentity[],
    revokedPeers: PublicPeerIdentity[],
    revocations: GroupRevocationCertificate[],
    connectedPeerIds: readonly string[],
  ): GroupPeerTransitions {
    const active = new Map(activePeers.map((peer) => [peer.peerId, peer]));
    const revoked = new Map(revokedPeers.filter((peer) => !active.has(peer.peerId)).map((peer) => [peer.peerId, peer]));
    this.trusted.clear();
    this.revoked.clear();
    this.names.clear();
    this.verifyKeys.clear();
    for (const peer of active.values()) {
      this.trusted.set(peer.peerId, peer);
      this.names.set(peer.peerId, peer.displayName);
    }
    for (const peer of revoked.values()) this.revoked.set(peer.peerId, peer);
    this.certificates = revocations.filter(validGroupRevocationCertificate);
    return {
      revokedPeerIds: connectedPeerIds.filter((peerId) => this.revoked.has(peerId)),
      unknownPeerIds: connectedPeerIds.filter((peerId) => !this.revoked.has(peerId) && !this.trusted.has(peerId)),
    };
  }

  isTrustedRemote(remotePeerId: string, localPeerId: string | undefined, authenticated: boolean): boolean {
    if (!authenticated) return remotePeerId !== localPeerId;
    return remotePeerId !== localPeerId && (this.trusted.has(remotePeerId) || this.revoked.has(remotePeerId));
  }

  isTrusted(peerId: string): boolean { return this.trusted.has(peerId); }
  isRevoked(peerId: string): boolean { return this.revoked.has(peerId); }
  displayName(peerId: string): string | undefined { return this.names.get(peerId); }
  removeDisplayName(peerId: string): void { this.names.delete(peerId); }
  trustedPeerIds(): string[] { return [...this.trusted.keys()]; }
  revocationsFor(peerId: string): GroupRevocationCertificate[] {
    return this.certificates.filter((item) => item.targetPeerId === peerId);
  }

  async acceptProfile(remotePeerId: string, message: ProfileUpdateWireMessage): Promise<boolean> {
    if (message.identity.peerId !== remotePeerId
      || !(await this.verifyCanonical(remotePeerId, message.signature, canonicalProfileUpdate(message)))) return false;
    await updateKnownPeerProfile(message.identity);
    this.trusted.set(remotePeerId, message.identity);
    this.names.set(remotePeerId, message.identity.displayName);
    this.verifyKeys.delete(remotePeerId);
    return true;
  }

  async verifySignedMessage(message: SignedChatWireMessage): Promise<boolean> {
    return this.verifyCanonical(message.authorPeerId, message.signature, canonicalSignedMessage(message));
  }

  async verifyCanonical(peerId: string, signature: string, canonical: string): Promise<boolean> {
    const peer = this.trusted.get(peerId) ?? this.revoked.get(peerId);
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

  async createMembershipSnapshot(
    groupId: string,
    channelId: string,
    identity: LocalIdentity,
  ): Promise<GroupMembersWireMessage | null> {
    const group = (await loadLocalGroups()).find((item) => item.groupId === groupId);
    if (!group || (group.ownerPeerId !== identity.peerId && !(group.administratorPeerIds ?? []).includes(identity.peerId))) return null;
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
    const message: GroupMembersWireMessage = { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_WIRE_BYTES) {
      throw new Error("O manifesto do grupo excedeu o limite P2P seguro. Reduza a imagem do grupo, canais ou histórico de membros antes de sincronizar.");
    }
    return message;
  }

  async acceptMembership(
    groupId: string,
    localIdentity: LocalIdentity,
    remotePeerId: string,
    message: GroupMembersWireMessage,
  ): Promise<AcceptedGroupMembership | null> {
    if (message.groupId !== groupId || message.senderPeerId !== remotePeerId) return null;
    const current = (await loadLocalGroups()).find((group) => group.groupId === groupId);
    if (!current) return null;
    const senderAuthorized = current.ownerPeerId === remotePeerId || (current.administratorPeerIds ?? []).includes(remotePeerId);
    if (!senderAuthorized
      || !(await this.verifyCanonical(remotePeerId, message.signature, canonicalGroupMembership(message)))) return null;
    if (message.ownerPeerId !== current.ownerPeerId) return null;
    if (remotePeerId !== current.ownerPeerId
      && (message.administratorEpoch !== (current.administratorEpoch ?? 1)
        || JSON.stringify([...message.administratorPeerIds].sort()) !== JSON.stringify([...(current.administratorPeerIds ?? [])].sort()))) return null;
    if (!(await this.validateRemovalAuthority(current, message))) return null;
    const incoming: LocalGroup = {
      ...current,
      name: message.name,
      avatar: message.avatar,
      channels: message.channels,
      members: message.members,
      ownerPeerId: message.ownerPeerId,
      membershipVersion: message.membershipVersion,
      manifestVersion: message.manifestVersion,
      manifestActorPeerId: message.manifestActorPeerId,
      manifestOperationId: message.manifestOperationId,
      administratorEpoch: message.administratorEpoch,
      administratorGrants: message.administratorGrants,
      administratorPeerIds: message.administratorPeerIds,
      removedPeerIds: message.removedPeerIds,
      removedMembers: message.removedMembers,
      revocations: message.revocations,
      rendezvousVersion: message.rendezvousVersion,
      rendezvousSecret: message.rendezvousSecret,
    };
    const merged = await mergeLocalGroupManifest(incoming, remotePeerId);
    const localCanAnswer = merged.ownerPeerId === localIdentity.peerId
      || (merged.administratorPeerIds ?? []).includes(localIdentity.peerId);
    return { merged, shouldReply: localCanAnswer && !sameLocalGroupManifestState(incoming, merged) };
  }

  async createProfileUpdate(identity: LocalIdentity, channelId: string): Promise<ProfileUpdateWireMessage> {
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
    return { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
  }

  private async validateRemovalAuthority(current: LocalGroup, message: GroupMembersWireMessage): Promise<boolean> {
    const knownById = new Map<string, PublicPeerIdentity>();
    for (const member of [
      ...current.members,
      ...(current.removedMembers ?? []),
      ...message.members,
      ...message.removedMembers,
    ]) {
      const known = knownById.get(member.peerId);
      if (known && !sameIdentityKey(known, member)) return false;
      knownById.set(member.peerId, member);
    }
    const owner = knownById.get(current.ownerPeerId);
    if (!owner || !message.members.some((member) => member.peerId === owner.peerId && sameIdentityKey(member, owner))) return false;

    const verificationGroup: LocalGroup = {
      ...current,
      members: [...knownById.values()],
      removedMembers: [...knownById.values()],
    };
    const validCertificates = new Map<string, GroupRevocationCertificate>();
    for (const certificate of message.revocations) {
      const trustedCertificate = (current.revocations ?? []).find((known) => known.messageId === certificate.messageId);
      if (trustedCertificate) {
        // Certificados antigos de administradores continuam válidos depois de
        // uma troca de época. Só reutilizamos o certificado byte a byte
        // equivalente ao que já foi verificado e persistido localmente.
        if (trustedCertificate.signature !== certificate.signature
          || canonicalGroupRevocation(trustedCertificate) !== canonicalGroupRevocation(certificate)) return false;
        validCertificates.set(certificate.targetPeerId, certificate);
        continue;
      }
      if (certificate.targetPeerId === current.ownerPeerId
        || !(await verifyGroupRevocationCertificate(certificate, verificationGroup, true))) return false;
      // Um administrador pode retransmitir uma decisão assinada pelo dono, mas
      // não pode produzir por conta própria a remoção de outro administrador.
      if (certificate.issuerPeerId !== current.ownerPeerId
        && (current.administratorPeerIds ?? []).includes(certificate.targetPeerId)) return false;
      validCertificates.set(certificate.targetPeerId, certificate);
    }

    const alreadyRemoved = new Set(current.removedPeerIds ?? []);
    const incomingRemoved = new Set(message.removedPeerIds);
    if (incomingRemoved.has(current.ownerPeerId)) return false;
    for (const peerId of incomingRemoved) {
      if (!alreadyRemoved.has(peerId) && !validCertificates.has(peerId)) return false;
    }
    return message.removedMembers.every((member) => incomingRemoved.has(member.peerId)
      && sameIdentityKey(member, knownById.get(member.peerId)));
  }
}

function sameIdentityKey(left: PublicPeerIdentity | undefined, right: PublicPeerIdentity | undefined): boolean {
  if (!left || !right || left.peerId !== right.peerId) return false;
  return left.publicKey.kty === right.publicKey.kty
    && left.publicKey.crv === right.publicKey.crv
    && left.publicKey.x === right.publicKey.x
    && left.publicKey.y === right.publicKey.y;
}

export async function inferLocalGroupSecurity(
  channelId: string,
  displayName: string,
): Promise<InferredGroupSecurity | null> {
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
