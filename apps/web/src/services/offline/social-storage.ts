import { OFFLINE_STORES, getAllFromStore, openRiskDatabase, putInStore } from "./database";

export type PublicPeerIdentity = { peerId: string; publicKey: JsonWebKey; displayName: string; avatar?: string };
export type LocalIdentity = PublicPeerIdentity & { id: "self"; privateKey: CryptoKey };
export type LocalFriend = PublicPeerIdentity & { addedAt: number };
export type LocalGroupChannel = { id: string; name: string; kind: "text" | "voice"; voiceRoomId?: string | null };
export type PublicGroupMetadata = { groupId: string; name: string; avatar?: string; channels: LocalGroupChannel[] };
export type LocalGroup = PublicGroupMetadata & { members: PublicPeerIdentity[]; joinedAt: number };

export async function loadLocalIdentity(): Promise<LocalIdentity | null> {
  const database = await openRiskDatabase();
  try {
    const store = database.transaction(OFFLINE_STORES.identity, "readonly").objectStore(OFFLINE_STORES.identity);
    const identity = await request<LocalIdentity | undefined>(store.get("self"));
    if (!identity) return null;
    if (!identity.privateKey.extractable) return identity;
    const migrated = { ...identity, privateKey: await makePrivateKeyNonExtractable(identity.privateKey) };
    await putInStore(OFFLINE_STORES.identity, migrated);
    return migrated;
  } finally { database.close(); }
}

export async function getOrCreateLocalIdentity(displayName: string): Promise<LocalIdentity> {
  let existing = await loadLocalIdentity();
  if (existing) {
    if (existing.displayName !== displayName) {
      existing = { ...existing, displayName };
      await putInStore(OFFLINE_STORES.identity, existing);
    }
    return existing;
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const identity: LocalIdentity = {
    id: "self",
    peerId: crypto.randomUUID(),
    displayName,
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: await makePrivateKeyNonExtractable(pair.privateKey),
  };
  await putInStore(OFFLINE_STORES.identity, identity);
  return identity;
}

export function loadLocalFriends(): Promise<LocalFriend[]> { return getAllFromStore<LocalFriend>(OFFLINE_STORES.friends); }
export function saveLocalFriend(friend: LocalFriend): Promise<void> { return putInStore(OFFLINE_STORES.friends, friend); }
export function loadLocalGroups(): Promise<LocalGroup[]> { return getAllFromStore<LocalGroup>(OFFLINE_STORES.groups); }
export function saveLocalGroup(group: LocalGroup): Promise<void> { return putInStore(OFFLINE_STORES.groups, group); }

export async function createLocalGroup(name: string, owner: PublicPeerIdentity): Promise<LocalGroup> {
  const trimmedName = name.trim();
  if (trimmedName.length < 2 || trimmedName.length > 80) throw new Error("O nome do grupo deve ter entre 2 e 80 caracteres.");
  const groupId = crypto.randomUUID();
  const group: LocalGroup = {
    groupId, name: trimmedName, members: [owner], joinedAt: Date.now(),
    channels: [
      { id: crypto.randomUUID(), name: "geral", kind: "text" },
      { id: crypto.randomUUID(), name: "Geral", kind: "voice", voiceRoomId: crypto.randomUUID() },
    ],
  };
  await saveLocalGroup(group);
  return group;
}

export async function addLocalGroupChannel(groupId: string, channel: LocalGroupChannel): Promise<void> {
  const group = (await loadLocalGroups()).find((item) => item.groupId === groupId);
  if (!group) throw new Error("Grupo local não encontrado.");
  const name = channel.name.trim();
  if (name.length < 2 || name.length > 80) throw new Error("O nome do canal deve ter entre 2 e 80 caracteres.");
  const normalized = { ...channel, name };
  if (!group.channels.some((item) => item.id === normalized.id)) group.channels.push(normalized);
  await saveLocalGroup(group);
}

export async function ensureLocalGroup(groupId: string, name: string, owner: PublicPeerIdentity, channels: LocalGroupChannel[] = []): Promise<LocalGroup> {
  const existing = (await loadLocalGroups()).find((item) => item.groupId === groupId);
  if (existing) return existing;
  const local: LocalGroup = { groupId, name, members: [owner], joinedAt: Date.now(), channels };
  await saveLocalGroup(local);
  return local;
}

export async function addLocalGroupMember(group: PublicGroupMetadata, member: PublicPeerIdentity, owner: PublicPeerIdentity): Promise<void> {
  const current = (await loadLocalGroups()).find((item) => item.groupId === group.groupId);
  const members = [...(current?.members ?? [owner])];
  if (!members.some((item) => item.peerId === member.peerId)) members.push(member);
  await saveLocalGroup({ ...group, members, joinedAt: current?.joinedAt ?? Date.now() });
}

export function publicIdentity(identity: LocalIdentity): PublicPeerIdentity {
  return { peerId: identity.peerId, publicKey: identity.publicKey, displayName: identity.displayName, avatar: identity.avatar };
}

async function makePrivateKeyNonExtractable(privateKey: CryptoKey): Promise<CryptoKey> {
  if (!privateKey.extractable) return privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("Falha no armazenamento social local."));
  });
}
