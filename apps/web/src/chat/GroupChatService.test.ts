import { describe, expect, it } from "vitest";
import { GroupChatService } from "./GroupChatService";
import type {
  GroupRevocationCertificate,
  LocalGroup,
  LocalIdentity,
  PublicPeerIdentity,
} from "../services/offline/social-storage";
import type { GroupMembersWireMessage } from "./MessageProtocol";

const publicKey: JsonWebKey = { kty: "EC", crv: "P-256", x: "abc", y: "def" };

describe("GroupChatService", () => {
  it("faz a identidade local atual prevalecer sobre uma cópia antiga do manifesto", () => {
    const service = new GroupChatService();
    const stale: PublicPeerIdentity = {
      peerId: "peer_local_12345678",
      publicKey,
      displayName: "Nome antigo",
    };
    const current: LocalIdentity = {
      ...stale,
      id: "self",
      displayName: "Nome atualizado",
      privateKey: {} as CryptoKey,
    };

    service.configure(current, [stale], [], []);

    expect(service.displayName(current.peerId)).toBe("Nome atualizado");
    expect(service.trustedPeerIds()).toEqual([current.peerId]);
  });

  it("separa peers conectados revogados de identidades desconhecidas", () => {
    const service = new GroupChatService();
    const active: PublicPeerIdentity = { peerId: "peer_active_12345678", publicKey, displayName: "Ativo" };
    const revoked: PublicPeerIdentity = { peerId: "peer_revoked_12345678", publicKey, displayName: "Removido" };

    const transitions = service.install(
      [active],
      [revoked],
      [],
      [active.peerId, revoked.peerId, "peer_unknown_12345678"],
    );

    expect(transitions.revokedPeerIds).toEqual([revoked.peerId]);
    expect(transitions.unknownPeerIds).toEqual(["peer_unknown_12345678"]);
  });

  it("accepts an already trusted administrator revocation after the administrator epoch advances", async () => {
    const owner: PublicPeerIdentity = { peerId: "peer_owner_12345678", publicKey, displayName: "Dono" };
    const removed: PublicPeerIdentity = { peerId: "peer_removed_12345678", publicKey, displayName: "Removido" };
    const certificate: GroupRevocationCertificate = {
      version: 1,
      groupId: "group_revocation_12345678",
      targetPeerId: removed.peerId,
      targetPublicKey: removed.publicKey,
      issuerPeerId: "peer_old_admin_12345678",
      membershipVersion: 2,
      administratorEpoch: 1,
      messageId: "revocation_message_12345678",
      timestamp: 1,
      signature: "A".repeat(86),
    };
    const current = {
      groupId: certificate.groupId,
      name: "Grupo",
      channels: [],
      ownerPeerId: owner.peerId,
      members: [owner],
      membershipVersion: 3,
      manifestVersion: 3,
      removedMembers: [removed],
      removedPeerIds: [removed.peerId],
      administratorEpoch: 2,
      administratorPeerIds: [],
      revocations: [certificate],
      joinedAt: 1,
    } as LocalGroup;
    const message = {
      members: [owner],
      removedMembers: [removed],
      removedPeerIds: [removed.peerId],
      revocations: [certificate],
    } as GroupMembersWireMessage;
    const service = new GroupChatService() as unknown as {
      validateRemovalAuthority(group: LocalGroup, message: GroupMembersWireMessage): Promise<boolean>;
    };

    await expect(service.validateRemovalAuthority(current, message)).resolves.toBe(true);
    await expect(service.validateRemovalAuthority(current, {
      ...message,
      revocations: [{ ...certificate, signature: "B".repeat(86) }],
    })).resolves.toBe(false);
  });
});
