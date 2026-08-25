import { validGroupRevocationCertificate, type LocalIdentity, type PublicGroupMetadata, type PublicPeerIdentity } from "../offline/social-storage";
import { validAvatarDataUrl } from "../offline/profile";

export type InviteProtocolType = "friend.request" | "friend.accept" | "friend.reject" | "group.join.request" | "group.join.accept" | "group.join.reject" | "invite.ack" | "invite.busy";
export type SignedInviteMessage = {
  version: 1; type: InviteProtocolType; requestId: string; timestamp: number;
  identity: PublicPeerIdentity; group?: PublicGroupMetadata; reason?: string; signature: string;
};

const MAX_MESSAGE_BYTES = 48 * 1024;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;

export async function createSignedInviteMessage(
  identity: LocalIdentity,
  message: Omit<SignedInviteMessage, "version" | "identity" | "signature">,
): Promise<SignedInviteMessage> {
  const unsigned = { version: 1 as const, ...message, identity: publicIdentity(identity) };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, identity.privateKey, new TextEncoder().encode(canonical(unsigned)),
  );
  return { ...unsigned, signature: toBase64Url(new Uint8Array(signature)) };
}

export async function parseAndVerifyInviteMessage(raw: string, now = Date.now()): Promise<SignedInviteMessage | null> {
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isMessage(value) || Math.abs(now - value.timestamp) > MAX_CLOCK_SKEW_MS) return null;
  try {
    const { signature, ...unsigned } = value;
    const key = await crypto.subtle.importKey("jwk", value.identity.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(signature), new TextEncoder().encode(canonical(unsigned)),
    );
    return valid ? value : null;
  } catch { return null; }
}

function publicIdentity(identity: LocalIdentity): PublicPeerIdentity {
  return { peerId: identity.peerId, publicKey: identity.publicKey, displayName: identity.displayName, avatar: identity.avatar };
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
    && Boolean(identity.publicKey && typeof identity.publicKey === "object")
    && (identity.avatar === undefined || validAvatarDataUrl(identity.avatar));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function toBase64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromBase64Url(value: string): ArrayBuffer { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")); return Uint8Array.from(decoded, (char) => char.charCodeAt(0)).buffer; }
