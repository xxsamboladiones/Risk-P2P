import { describe, expect, it } from "vitest";
import { createGroupAdministratorGrant, type LocalIdentity } from "../offline/social-storage";
import { MAX_INVITE_MESSAGE_BYTES, createSignedInviteMessage, parseAndVerifyInviteMessage } from "./protocol";

async function identity(name: string): Promise<LocalIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { id: "self", peerId: crypto.randomUUID(), displayName: name, publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: pair.privateKey };
}

describe("protocolo assinado de convites", () => {
  it("assina e valida um pedido de amizade", async () => {
    const author = await identity("Maria"); const now = Date.now();
    const message = await createSignedInviteMessage(author, { type: "friend.request", requestId: crypto.randomUUID(), timestamp: now });
    const parsed = await parseAndVerifyInviteMessage(JSON.stringify(message), now);
    expect(parsed?.identity.displayName).toBe("Maria"); expect(parsed?.type).toBe("friend.request");
  });

  it("rejeita adulteração, mensagens antigas e payload excessivo", async () => {
    const author = await identity("João"); const now = Date.now();
    const message = await createSignedInviteMessage(author, { type: "group.join.request", requestId: crypto.randomUUID(), timestamp: now });
    expect(await parseAndVerifyInviteMessage(JSON.stringify({ ...message, identity: { ...message.identity, displayName: "Invasor" } }), now)).toBeNull();
    expect(await parseAndVerifyInviteMessage(JSON.stringify(message), now + 4 * 60_000)).not.toBeNull();
    expect(await parseAndVerifyInviteMessage(JSON.stringify(message), now + 6 * 60_000)).toBeNull();
    expect(await parseAndVerifyInviteMessage(`{"padding":"${"x".repeat(MAX_INVITE_MESSAGE_BYTES + 1_024)}"}`, now)).toBeNull();
  });

  it("aceita group.join.accept entre 48 e 64 KiB sem carregar avatares redundantes dos peers", async () => {
    const owner = await identity("Dona"); const now = Date.now();
    const largeAvatar = `data:image/png;base64,${"A".repeat(32_736)}`;
    const ownerWithAvatar: LocalIdentity = { ...owner, avatar: largeAvatar };
    const group = {
      groupId: crypto.randomUUID(),
      name: "Clã grande",
      avatar: largeAvatar,
      channels: Array.from({ length: 100 }, (_, index) => ({ id: crypto.randomUUID(), name: `canal-${index}-${"x".repeat(60)}`.slice(0, 80), kind: "text" as const })),
      ownerPeerId: owner.peerId,
      membershipVersion: 1,
      manifestVersion: 1,
      administratorPeerIds: [],
      removedPeerIds: Array.from({ length: 80 }, () => crypto.randomUUID()),
      removedMembers: [],
      ownerIdentity: { peerId: owner.peerId, displayName: owner.displayName, publicKey: owner.publicKey, avatar: largeAvatar },
    };
    const message = await createSignedInviteMessage(ownerWithAvatar, { type: "group.join.accept", requestId: crypto.randomUUID(), timestamp: now, group });
    const raw = JSON.stringify(message);
    const bytes = new TextEncoder().encode(raw).byteLength;
    expect(bytes).toBeGreaterThan(48 * 1024);
    expect(bytes).toBeLessThanOrEqual(MAX_INVITE_MESSAGE_BYTES);
    expect(message.identity.avatar).toBeUndefined();
    expect(message.group?.ownerIdentity?.avatar).toBeUndefined();
    expect(await parseAndVerifyInviteMessage(raw, now)).not.toBeNull();
  });

  it("aceita manifesto de grupo do proprietário e de administrador autorizado", async () => {
    const owner = await identity("Dona"); const now = Date.now();
    const group = { groupId: crypto.randomUUID(), name: "Clã", channels: [], ownerPeerId: owner.peerId, membershipVersion: 1, manifestVersion: 1, administratorPeerIds: [], removedPeerIds: [], removedMembers: [] };
    const valid = await createSignedInviteMessage(owner, { type: "group.join.accept", requestId: crypto.randomUUID(), timestamp: now, group });
    expect(await parseAndVerifyInviteMessage(JSON.stringify(valid), now)).not.toBeNull();
    const invalid = await createSignedInviteMessage(owner, { type: "group.join.accept", requestId: crypto.randomUUID(), timestamp: now, group: { ...group, ownerPeerId: crypto.randomUUID() } });
    expect(await parseAndVerifyInviteMessage(JSON.stringify(invalid), now)).toBeNull();
    const invalidAvatar = await createSignedInviteMessage(owner, { type: "group.join.accept", requestId: crypto.randomUUID(), timestamp: now, group: { ...group, avatar: "data:text/html;base64,PHNjcmlwdD4=" } });
    // O emissor remove avatar legado/inválido antes de assinar para que um dado de
    // apresentação não invalide todo o handshake de entrada no grupo.
    expect(invalidAvatar.group?.avatar).toBeUndefined();
    expect(await parseAndVerifyInviteMessage(JSON.stringify(invalidAvatar), now)).not.toBeNull();

    const administrator = await identity("Admin");
    const adminGroup = {
      ...group,
      administratorPeerIds: [administrator.peerId],
      administratorEpoch: 2,
      ownerIdentity: { peerId: owner.peerId, displayName: owner.displayName, publicKey: owner.publicKey },
    };
    const grant = await createGroupAdministratorGrant(adminGroup, {
      peerId: administrator.peerId,
      displayName: administrator.displayName,
      publicKey: administrator.publicKey,
    }, owner, 2);
    const authorizedAdminGroup = { ...adminGroup, administratorGrants: [grant] };
    const adminInvite = await createSignedInviteMessage(administrator, { type: "group.join.accept", requestId: crypto.randomUUID(), timestamp: now, group: authorizedAdminGroup });
    expect(await parseAndVerifyInviteMessage(JSON.stringify(adminInvite), now)).not.toBeNull();
    const unauthorized = await createSignedInviteMessage(administrator, { type: "group.join.accept", requestId: crypto.randomUUID(), timestamp: now, group: { ...authorizedAdminGroup, administratorPeerIds: [] } });
    expect(await parseAndVerifyInviteMessage(JSON.stringify(unauthorized), now)).toBeNull();
    const forged = await createSignedInviteMessage(administrator, { type: "group.join.accept", requestId: crypto.randomUUID(), timestamp: now, group: { ...authorizedAdminGroup, administratorGrants: [{ ...grant, administratorEpoch: 3 }] } });
    expect(await parseAndVerifyInviteMessage(JSON.stringify(forged), now)).toBeNull();
  });
});
