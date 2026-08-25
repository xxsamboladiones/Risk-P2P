import { describe, expect, it } from "vitest";
import { canManageLocalGroup, reconcileIdentityMembership, type LocalGroup, type LocalIdentity, type PublicGroupMetadata } from "./social-storage";

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
    expect(persisted).toHaveLength(1);
  });
});
