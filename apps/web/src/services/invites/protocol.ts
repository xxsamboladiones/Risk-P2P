import { validGroupAdministratorGrant, validGroupRevocationCertificate, verifyGroupAdministratorGrant, type LocalIdentity, type PublicGroupMetadata, type PublicPeerIdentity } from "../offline/social-storage";
import { validAvatarDataUrl } from "../offline/profile";

export type InviteProtocolType = "friend.request" | "friend.accept" | "friend.reject" | "group.join.request" | "group.join.accept" | "group.join.reject" | "invite.ack" | "invite.busy";
export type SignedInviteMessage = {
  version: 1; type: InviteProtocolType; requestId: string; timestamp: number;
  identity: PublicPeerIdentity; group?: PublicGroupMetadata; reason?: string; signature: string;
};

// O DataChannel de controle do MeshWebRTCTransport aceita até 64 KiB. O parser
// precisa aceitar exatamente a mesma faixa para nunca descartar silenciosamente
// uma mensagem que o transporte acabou de entregar com sucesso.
export const MAX_INVITE_MESSAGE_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;

export async function createSignedInviteMessage(
  identity: LocalIdentity,
  message: Omit<SignedInviteMessage, "version" | "identity" | "signature">,
): Promise<SignedInviteMessage> {
  const groupAccept = message.type === "group.join.accept" && message.group;
  const normalizedMessage = groupAccept
    ? { ...message, group: compactGroupInviteMetadata(message.group!) }
    : message;
  // No aceite de grupo, os avatares dos peers são dados redundantes: o avatar do
  // grupo continua no manifesto e os perfis são reconciliados depois pelo canal
  // P2P. Removê-los evita que dois avatares de 32 KiB estourem o frame de controle.
  const unsigned = {
    version: 1 as const,
    ...normalizedMessage,
    identity: publicIdentity(identity, !groupAccept),
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, identity.privateKey, new TextEncoder().encode(canonical(unsigned)),
  );
  return { ...unsigned, signature: toBase64Url(new Uint8Array(signature)) };
}

export async function parseAndVerifyInviteMessage(raw: string, now = Date.now()): Promise<SignedInviteMessage | null> {
  if (new TextEncoder().encode(raw).byteLength > MAX_INVITE_MESSAGE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isMessage(value) || Math.abs(now - value.timestamp) > MAX_CLOCK_SKEW_MS) return null;
  try {
    const { signature, ...unsigned } = value;
    const key = await crypto.subtle.importKey("jwk", value.identity.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(signature), new TextEncoder().encode(canonical(unsigned)),
    );
    if (!valid) return null;
    if (value.type === "group.join.accept" && value.group && value.identity.peerId !== value.group.ownerPeerId) {
      const owner = value.group.ownerIdentity;
      const grant = (value.group.administratorGrants ?? []).find((candidate) =>
        candidate.administratorPeerId === value.identity.peerId
        && candidate.administratorEpoch === (value.group!.administratorEpoch ?? 1));
      if (!owner || !grant || !(await verifyGroupAdministratorGrant(grant, {
        ...value.group,
        members: [owner, value.identity],
      }))) return null;
    }
    return value;
  } catch { return null; }
}

function compactGroupInviteMetadata(group: PublicGroupMetadata): PublicGroupMetadata {
  return {
    ...group,
    // Avatares antigos ou fora do formato atual não podem invalidar todo o
    // handshake. O manifesto chega sem a imagem e ela pode ser reconciliada
    // posteriormente; avatares válidos do próprio grupo continuam preservados.
    avatar: group.avatar && validAvatarDataUrl(group.avatar) ? group.avatar : undefined,
    ownerIdentity: group.ownerIdentity ? withoutAvatar(group.ownerIdentity) : undefined,
    removedMembers: (group.removedMembers ?? []).map(withoutAvatar),
  };
}

function withoutAvatar(identity: PublicPeerIdentity): PublicPeerIdentity {
  const { avatar: _avatar, ...rest } = identity;
  return rest;
}

function publicIdentity(identity: LocalIdentity, includeAvatar = true): PublicPeerIdentity {
  const base = { peerId: identity.peerId, publicKey: identity.publicKey, displayName: identity.displayName };
  return includeAvatar && identity.avatar ? { ...base, avatar: identity.avatar } : base;
}

function isMessage(value: unknown): value is SignedInviteMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>; const identity = item.identity as Record<string, unknown> | undefined;
  const types: InviteProtocolType[] = ["friend.request", "friend.accept", "friend.reject", "group.join.request", "group.join.accept", "group.join.reject", "invite.ack", "invite.busy"];
  const type = item.type as InviteProtocolType;
  return item.version === 1 && types.includes(type) && validId(item.requestId) &&
    typeof item.timestamp === "number" && Number.isFinite(item.timestamp) && typeof item.signature === "string" && item.signature.length < 512 &&
    Boolean(identity && isPeerIdentity(identity)) &&
    (item.reason === undefined || (typeof item.reason === "string" && item.reason.length <= 200)) &&
    (type !== "group.join.accept" || (isGroup(item.group) && ((item.group as PublicGroupMetadata).ownerPeerId === identity?.peerId || ((item.group as PublicGroupMetadata).administratorPeerIds.includes(String(identity?.peerId)) && Boolean((item.group as PublicGroupMetadata).ownerIdentity)))));
}

function isGroup(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const group = value as Record<string, unknown>;
  if (!validId(group.groupId) || !validId(group.ownerPeerId) || !Number.isSafeInteger(group.membershipVersion) || Number(group.membershipVersion) < 1 || !Number.isSafeInteger(group.manifestVersion) || Number(group.manifestVersion) < 1 || !Array.isArray(group.administratorPeerIds) || group.administratorPeerIds.length > 64 || !group.administratorPeerIds.every(validId) || !Array.isArray(group.removedPeerIds) || group.removedPeerIds.length > 256 || !group.removedPeerIds.every(validId) || !Array.isArray(group.removedMembers) || group.removedMembers.length > 256 || !group.removedMembers.every(isPeerIdentity) || typeof group.name !== "string" || group.name.length < 1 || group.name.length > 80 || (group.avatar !== undefined && !validAvatarDataUrl(group.avatar)) || !Array.isArray(group.channels) || group.channels.length > 100) return false;
  if ((group.manifestActorPeerId !== undefined && !validId(group.manifestActorPeerId))
    || (group.manifestOperationId !== undefined && !validId(group.manifestOperationId))
    || (group.administratorEpoch !== undefined && (!Number.isSafeInteger(group.administratorEpoch) || Number(group.administratorEpoch) < 1))
    || (group.administratorGrants !== undefined && (!Array.isArray(group.administratorGrants) || group.administratorGrants.length > 48 || !group.administratorGrants.every(validGroupAdministratorGrant)))
    || (group.rendezvousVersion !== undefined && (!Number.isSafeInteger(group.rendezvousVersion) || Number(group.rendezvousVersion) < 1))
    || (group.rendezvousSecret !== undefined && !validId(group.rendezvousSecret))
    || (group.revocations !== undefined && (!Array.isArray(group.revocations) || group.revocations.length > 48 || !group.revocations.every(validGroupRevocationCertificate)))) return false;
  if (group.ownerIdentity !== undefined) {
    const owner = group.ownerIdentity as Record<string, unknown>;
    if (!owner || owner.peerId !== group.ownerPeerId || !isPeerIdentity(owner)) return false;
  }
  return group.channels.every((value) => {
    if (!value || typeof value !== "object") return false;
    const channel = value as Record<string, unknown>;
    return validId(channel.id) && typeof channel.name === "string" && channel.name.length >= 1 && channel.name.length <= 80 &&
      (channel.kind === "text" || channel.kind === "voice") &&
      (channel.voiceRoomId === undefined || channel.voiceRoomId === null || validId(channel.voiceRoomId));
  });
}

function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value); }
function isPeerIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return validId(identity.peerId) && typeof identity.displayName === "string" && identity.displayName.length >= 1 && identity.displayName.length <= 80
    && isP256PublicKey(identity.publicKey)
    && (identity.avatar === undefined || validAvatarDataUrl(identity.avatar));
}
function isP256PublicKey(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return key.kty === "EC" && key.crv === "P-256"
    && typeof key.x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key.x)
    && typeof key.y === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key.y);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function toBase64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromBase64Url(value: string): ArrayBuffer { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")); return Uint8Array.from(decoded, (char) => char.charCodeAt(0)).buffer; }
