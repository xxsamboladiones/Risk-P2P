import { describe, expect, it } from "vitest";
import {
  canManageLocalGroup,
  compareGroupManifestRevisions,
  createGroupAdministratorGrant,
  createGroupRevocationCertificate,
  groupRendezvousId,
  reconcileIdentityMembership,
  resolveLocalGroupManifest,
  upsertGroupMemberIdentity,
  verifyGroupRevocationCertificate,
  type LocalGroup,
  type LocalIdentity,
  type PublicGroupMetadata,
} from "./social-storage";

const group: PublicGroupMetadata = {
  groupId: "group_12345678",
  name: "Grupo",
  channels: [],
  ownerPeerId: "owner_12345678",
  membershipVersion: 1,
  manifestVersion: 1,
  administratorPeerIds: ["admin_12345678"],
  removedPeerIds: [],
  removedMembers: [],
};

describe("permissões de grupo local", () => {
  it("permite gerenciamento ao proprietário e aos administradores", () => {
    expect(canManageLocalGroup(group, "owner_12345678")).toBe(true);
    expect(canManageLocalGroup(group, "admin_12345678")).toBe(true);
  });

  it("não concede gerenciamento a membros comuns ou removidos", () => {
    expect(canManageLocalGroup(group, "member_12345678")).toBe(false);
    expect(canManageLocalGroup(group, "removed_12345678")).toBe(false);
  });

  it("mantém compatibilidade com grupos salvos antes do campo de administradores", () => {
    const legacy = { ...group, administratorPeerIds: undefined } as unknown as PublicGroupMetadata;
    expect(() => canManageLocalGroup(legacy, "member_12345678")).not.toThrow();
    expect(canManageLocalGroup(legacy, "owner_12345678")).toBe(true);
  });

  it("substitui um perfil parcial antigo pela identidade autenticada no novo convite", () => {
    const stale = { peerId: "member_12345678", displayName: "Perfil antigo", publicKey: { kty: "EC", crv: "P-256", x: "old-x", y: "old-y" } };
    const authenticated = { peerId: stale.peerId, displayName: "Perfil atual", publicKey: { kty: "EC", crv: "P-256", x: "new-x", y: "new-y" } };
    expect(upsertGroupMemberIdentity([stale], authenticated)).toEqual([authenticated]);
  });

  it("normaliza campos ausentes e recupera o proprietário de uma lista vazia", async () => {
    const identity = {
      id: "self",
      peerId: group.ownerPeerId,
      displayName: "Proprietário",
      publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      privateKey: {} as CryptoKey,
    } satisfies LocalIdentity;
    const legacy = {
      ...group,
      members: [],
      joinedAt: Date.now(),
      administratorPeerIds: undefined,
      removedMembers: undefined,
      removedPeerIds: [group.ownerPeerId],
    } as unknown as LocalGroup;
    const persisted: LocalGroup[] = [];
    const [normalized] = await reconcileIdentityMembership([legacy], identity, async (value) => { persisted.push(value); });
    expect(normalized?.members.map((member) => member.peerId)).toEqual([group.ownerPeerId]);
    expect(normalized?.removedPeerIds).toEqual([]);
    expect(normalized?.removedMembers).toEqual([]);
    expect(normalized?.administratorPeerIds).toEqual([]);
    expect(normalized?.administratorEpoch).toBe(1);
    expect(normalized?.manifestActorPeerId).toBe(group.ownerPeerId);
    expect(normalized?.revocations).toEqual([]);
    expect(persisted).toHaveLength(1);
  });

  it("desempata revisões concorrentes de forma determinística e prioriza o proprietário", () => {
    const first = { ...group, manifestVersion: 7, manifestActorPeerId: "admin_a12345678", manifestOperationId: "operation_a12345678" };
    const second = { ...group, manifestVersion: 7, manifestActorPeerId: "admin_b12345678", manifestOperationId: "operation_b12345678" };
    expect(Math.sign(compareGroupManifestRevisions(first, second)))
      .toBe(-Math.sign(compareGroupManifestRevisions(second, first)));
    expect(compareGroupManifestRevisions(first, second)).not.toBe(0);
    const owner = { ...first, manifestActorPeerId: group.ownerPeerId };
    expect(compareGroupManifestRevisions(owner, second)).toBeGreaterThan(0);
  });

  it("faz dois manifestos concorrentes convergirem e preserva remoções", () => {
    const owner = peer("owner_12345678", "Proprietário", "owner");
    const adminA = peer("admin_a12345678", "Admin A", "admin-a");
    const adminB = peer("admin_b12345678", "Admin B", "admin-b");
    const target = peer("member_12345678", "Membro", "member");
    const base: LocalGroup = {
      ...group,
      ownerPeerId: owner.peerId,
      members: [owner, adminA, adminB, target],
      administratorPeerIds: [adminA.peerId, adminB.peerId],
      joinedAt: 1,
      manifestActorPeerId: owner.peerId,
      manifestOperationId: "operation_base_12345678",
      administratorEpoch: 1,
      revocations: [],
    };
    const left: LocalGroup = { ...base, name: "Edição A", manifestVersion: 2, manifestActorPeerId: adminA.peerId, manifestOperationId: "operation_a12345678" };
    const certificate = {
      version: 1 as const,
      groupId: base.groupId,
      targetPeerId: target.peerId,
      targetPublicKey: target.publicKey,
      issuerPeerId: adminB.peerId,
      membershipVersion: 2,
      administratorEpoch: 1,
      messageId: "revocation_12345678",
      timestamp: 1,
      signature: "A".repeat(86),
    };
    const right: LocalGroup = {
      ...base,
      name: "Edição B",
      members: base.members.filter((member) => member.peerId !== target.peerId),
      removedPeerIds: [target.peerId],
      removedMembers: [target],
      revocations: [certificate],
      membershipVersion: 2,
      manifestVersion: 2,
      manifestActorPeerId: adminB.peerId,
      manifestOperationId: "operation_b12345678",
    };

    const fromLeft = resolveLocalGroupManifest(left, right, adminB.peerId);
    const fromRight = resolveLocalGroupManifest(right, left, adminA.peerId);
    expect(fromLeft.name).toBe("Edição B");
    expect(fromRight.name).toBe("Edição B");
    expect(fromLeft.members.map((member) => member.peerId)).toEqual(fromRight.members.map((member) => member.peerId));
    expect(fromLeft.removedPeerIds).toEqual([target.peerId]);
    expect(fromRight.removedPeerIds).toEqual([target.peerId]);
    expect(fromLeft.revocations).toEqual(fromRight.revocations);
  });

  it("não deixa um administrador rebaixado sobrescrever o epoch do proprietário", () => {
    const owner = peer("owner_12345678", "Proprietário", "owner");
    const formerAdmin = peer("admin_a12345678", "Ex-admin", "admin-a");
    const current: LocalGroup = {
      ...group,
      name: "Nome autorizado",
      ownerPeerId: owner.peerId,
      members: [owner, formerAdmin],
      administratorPeerIds: [],
      administratorEpoch: 2,
      joinedAt: 1,
      manifestVersion: 3,
      manifestActorPeerId: owner.peerId,
      manifestOperationId: "owner_epoch_12345678",
      revocations: [],
    };
    const stale: LocalGroup = {
      ...current,
      name: "Nome não autorizado",
      administratorPeerIds: [formerAdmin.peerId],
      administratorEpoch: 1,
      manifestVersion: 99,
      manifestActorPeerId: formerAdmin.peerId,
      manifestOperationId: "stale_admin_12345678",
    };
    const merged = resolveLocalGroupManifest(current, stale, formerAdmin.peerId);
    expect(merged.name).toBe("Nome autorizado");
    expect(merged.administratorEpoch).toBe(2);
    expect(merged.administratorPeerIds).toEqual([]);
  });

  it("converge para o rendezvous rotacionado do proprietário", () => {
    const owner = peer("owner_12345678", "Proprietário", "owner");
    const current: LocalGroup = {
      ...group,
      members: [owner],
      ownerPeerId: owner.peerId,
      joinedAt: 1,
      manifestActorPeerId: owner.peerId,
      manifestOperationId: "operation_old_12345678",
      administratorEpoch: 1,
      revocations: [],
      rendezvousVersion: 1,
      rendezvousSecret: "secret_old_12345678",
    };
    const rotated: LocalGroup = {
      ...current,
      membershipVersion: 2,
      manifestVersion: 2,
      manifestOperationId: "operation_new_12345678",
      rendezvousVersion: 2,
      rendezvousSecret: "secret_new_12345678",
    };
    const merged = resolveLocalGroupManifest(current, rotated, owner.peerId);
    expect(merged.rendezvousVersion).toBe(2);
    expect(merged.rendezvousSecret).toBe("secret_new_12345678");
    expect(groupRendezvousId(merged, "chat", "channel_12345678"))
      .not.toBe(groupRendezvousId(current, "chat", "channel_12345678"));
  });

  it("cria uma revogação assinada que pode ser retransmitida sem a chave privada do emissor", async () => {
    const owner = await createIdentity("owner_12345678", "Proprietário");
    const member = await createIdentity("member_12345678", "Membro");
    const localGroup: LocalGroup = {
      ...group,
      ownerPeerId: owner.peerId,
      members: [owner, member],
      joinedAt: Date.now(),
      manifestActorPeerId: owner.peerId,
      manifestOperationId: "operation_12345678",
      administratorEpoch: 1,
      revocations: [],
    };
    const certificate = await createGroupRevocationCertificate(localGroup, member, owner, 2);
    expect(await verifyGroupRevocationCertificate(certificate, localGroup)).toBe(true);
    expect(await verifyGroupRevocationCertificate({ ...certificate, targetPeerId: "tampered_12345678" }, localGroup)).toBe(false);
  });

  it("aceita a revogação de um administrador somente no epoch em que ele estava autorizado", async () => {
    const owner = await createIdentity("owner_12345678", "Proprietário");
    const administrator = await createIdentity("admin_12345678", "Administrador");
    const member = await createIdentity("member_12345678", "Membro");
    const authorized: LocalGroup = {
      ...group,
      ownerPeerId: owner.peerId,
      members: [owner, administrator, member],
      administratorPeerIds: [administrator.peerId],
      joinedAt: Date.now(),
      manifestActorPeerId: owner.peerId,
      manifestOperationId: "admin_grant_12345678",
      administratorEpoch: 1,
      revocations: [],
    };
    const administratorGrant = await createGroupAdministratorGrant(authorized, administrator, owner, 2);
    authorized.administratorEpoch = 2;
    authorized.administratorGrants = [administratorGrant];
    const certificate = await createGroupRevocationCertificate(authorized, member, administrator, 2);
    expect(await verifyGroupRevocationCertificate(certificate, authorized)).toBe(true);
    expect(await verifyGroupRevocationCertificate(certificate, {
      ...authorized,
      administratorPeerIds: [],
      administratorGrants: [],
      administratorEpoch: 1,
    })).toBe(true);
    expect(await verifyGroupRevocationCertificate(certificate, {
      ...authorized,
      administratorPeerIds: [],
      administratorGrants: [],
      administratorEpoch: 3,
    })).toBe(false);
    expect(await verifyGroupRevocationCertificate({
      ...certificate,
      administratorGrant: { ...administratorGrant, administratorPublicKey: member.publicKey },
    }, authorized)).toBe(false);
  });
});

async function createIdentity(peerId: string, displayName: string): Promise<LocalIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    id: "self",
    peerId,
    displayName,
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: pair.privateKey,
  };
}

function peer(peerId: string, displayName: string, key: string) {
  return { peerId, displayName, publicKey: { kty: "EC", crv: "P-256", x: `${key}-x`, y: `${key}-y` } };
}
