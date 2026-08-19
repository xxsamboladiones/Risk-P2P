import {
  addLocalGroupChannel,
  getOrCreateLocalIdentity,
  loadLocalFriends,
  loadLocalGroups,
  loadLocalIdentity,
} from "./services/offline/social-storage";
import { resolveStaticIceConfiguration } from "./services/rtc/ice";

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, "");
const API_URL = configuredApiUrl || (import.meta.env.DEV ? "http://localhost:8080" : "");
const LOCAL_TOKEN_PREFIX = "risk-local:";
let refreshInFlight: Promise<string | null> | undefined;

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export type Friend = { id: string; displayName: string; local?: boolean };
export type PendingFriend = Friend & { requestId: string };
export type Community = { id: string; name: string; local?: boolean };
export type Channel = { id: string; name: string; kind: "text" | "voice"; voiceRoomId?: string | null };
export type ChatMessage = { id: string; author: string; content: string; createdAt: string };
export type CommunityInvite = { id: string; communityId: string; communityName: string; inviter: string };
export type CurrentUser = { id: string; displayName: string; email: string };

export function isApiConfigured(): boolean { return Boolean(API_URL); }
export function isLocalSessionToken(token: string | null | undefined): boolean { return Boolean(token?.startsWith(LOCAL_TOKEN_PREFIX)); }

function requireApiUrl(): string {
  if (!API_URL) {
    throw new ApiRequestError(
      "A API central do Risk não está configurada neste build. O modo P2P local continua disponível.",
      0,
    );
  }
  return API_URL;
}

function localToken(peerId: string): string { return `${LOCAL_TOKEN_PREFIX}${peerId}`; }

async function localSession(displayName?: string): Promise<{ accessToken: string }> {
  const identity = displayName
    ? await getOrCreateLocalIdentity(displayName.trim())
    : await loadLocalIdentity();
  if (!identity) {
    throw new ApiRequestError(
      "Nenhum perfil local existe neste dispositivo. Use “Criar uma conta” para criar seu perfil P2P local.",
      401,
    );
  }
  return { accessToken: localToken(identity.peerId) };
}

async function localCurrentUser(): Promise<CurrentUser> {
  const identity = await loadLocalIdentity();
  if (!identity) throw new ApiRequestError("Perfil P2P local não encontrado.", 401);
  return { id: identity.peerId, displayName: identity.displayName, email: "" };
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      if (!API_URL) return (await localSession()).accessToken;
      const response = await fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" });
      if (!response.ok) {
        sessionStorage.removeItem("accessToken");
        return null;
      }
      const session = await response.json() as { accessToken: string };
      sessionStorage.setItem("accessToken", session.accessToken);
      return session.accessToken;
    } catch {
      const identity = await loadLocalIdentity().catch(() => null);
      return identity ? localToken(identity.peerId) : null;
    } finally {
      refreshInFlight = undefined;
    }
  })();
  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const baseUrl = requireApiUrl();
  const headers = new Headers({ "content-type": "application/json", ...init.headers });
  if (headers.has("authorization")) {
    const current = sessionStorage.getItem("accessToken");
    if (current) headers.set("authorization", `Bearer ${current}`);
  }
  let response = await fetch(`${baseUrl}${path}`, { ...init, credentials: "include", headers });
  if (response.status === 401 && path !== "/auth/refresh") {
    const accessToken = await refreshAccessToken();
    if (accessToken && !isLocalSessionToken(accessToken)) {
      headers.set("authorization", `Bearer ${accessToken}`);
      response = await fetch(`${baseUrl}${path}`, { ...init, credentials: "include", headers });
    }
  }
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new ApiRequestError(body.message ?? "A operação falhou", response.status);
  return body;
}

async function register(displayName: string, email: string, password: string): Promise<{ accessToken: string }> {
  if (!API_URL) {
    const name = displayName.trim();
    if (name.length < 2 || name.length > 80) throw new ApiRequestError("Nome deve ter entre 2 e 80 caracteres.", 400);
    return localSession(name);
  }
  const result = await request<{ accessToken: string }>("/auth/register", { method: "POST", body: JSON.stringify({ displayName, email, password }) });
  sessionStorage.setItem("accessToken", result.accessToken);
  return result;
}

async function login(email: string, password: string): Promise<{ accessToken: string }> {
  if (!API_URL) return localSession();
  const result = await request<{ accessToken: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  sessionStorage.setItem("accessToken", result.accessToken);
  return result;
}

async function refresh(): Promise<{ accessToken: string }> {
  const accessToken = await refreshAccessToken();
  if (!accessToken) throw new ApiRequestError("Sessão indisponível.", 401);
  sessionStorage.setItem("accessToken", accessToken);
  return { accessToken };
}

async function logout(): Promise<void> {
  if (isLocalSessionToken(sessionStorage.getItem("accessToken")) || !API_URL) return;
  await request<void>("/auth/logout", { method: "POST" });
}

async function me(token: string): Promise<CurrentUser> {
  if (isLocalSessionToken(token) || !API_URL) return localCurrentUser();
  try {
    const profile = await request<CurrentUser>("/me", { method: "GET", headers: { authorization: `Bearer ${token}` } });
    await getOrCreateLocalIdentity(profile.displayName).catch(() => undefined);
    return profile;
  } catch (error) {
    const identity = await loadLocalIdentity().catch(() => null);
    if (identity && !(error instanceof ApiRequestError && error.status === 401)) {
      return { id: identity.peerId, displayName: identity.displayName, email: "" };
    }
    throw error;
  }
}

async function friends(token: string): Promise<{ friends: Friend[]; pending: PendingFriend[] }> {
  if (isLocalSessionToken(token) || !API_URL) {
    const local = await loadLocalFriends();
    return { friends: local.map((friend) => ({ id: friend.peerId, displayName: friend.displayName, local: true })), pending: [] };
  }
  return request<{ friends: Friend[]; pending: PendingFriend[] }>("/friends", { method: "GET", headers: { authorization: `Bearer ${token}` } });
}

async function communities(token: string): Promise<Community[]> {
  if (isLocalSessionToken(token) || !API_URL) {
    return (await loadLocalGroups()).map((group) => ({ id: group.groupId, name: group.name, local: true }));
  }
  return request<Community[]>("/communities", { method: "GET", headers: { authorization: `Bearer ${token}` } });
}

async function channels(token: string, communityId: string): Promise<Channel[]> {
  if (isLocalSessionToken(token) || !API_URL) {
    return (await loadLocalGroups()).find((group) => group.groupId === communityId)?.channels ?? [];
  }
  return request<Channel[]>(`/communities/${communityId}/channels`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
}

async function createChannel(token: string, communityId: string, name: string, kind: "text" | "voice"): Promise<Channel> {
  if (isLocalSessionToken(token) || !API_URL) {
    const channel: Channel = { id: crypto.randomUUID(), name: name.trim(), kind, voiceRoomId: kind === "voice" ? crypto.randomUUID() : null };
    await addLocalGroupChannel(communityId, channel);
    return channel;
  }
  return request<Channel>(`/communities/${communityId}/channels`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name, kind }) });
}

async function turnCredentials(token: string): Promise<{ iceServers: RTCIceServer[] }> {
  if (API_URL && !isLocalSessionToken(token)) {
    try {
      return await request<{ iceServers: RTCIceServer[] }>("/rtc/credentials", { method: "GET", headers: { authorization: `Bearer ${token}` } });
    } catch {
      // O backend/TURN dinâmico é um aprimoramento. STUN/configuração ICE local mantém o núcleo P2P operacional.
    }
  }
  return { iceServers: resolveStaticIceConfiguration().iceServers };
}

function centralOnly<T>(operation: () => Promise<T>): Promise<T> {
  if (!API_URL || isLocalSessionToken(sessionStorage.getItem("accessToken"))) {
    return Promise.reject(new ApiRequestError("Este recurso pertence ao modo central do Risk e não está disponível no perfil P2P local.", 0));
  }
  return operation();
}

export const api = {
  register,
  login,
  refresh,
  logout,
  me,
  friends,
  communities,
  channels,
  createChannel,
  addFriend: (token: string, email: string) => centralOnly(() => request<{ ok: boolean }>("/friends/requests", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ email }) })),
  acceptFriend: (token: string, requestId: string) => centralOnly(() => request<{ ok: boolean }>(`/friends/requests/${requestId}/accept`, { method: "POST", headers: { authorization: `Bearer ${token}` } })),
  createCommunity: (token: string, name: string) => centralOnly(() => request<Community>("/communities", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) })),
  addCommunityMember: (token: string, communityId: string, userId: string) => centralOnly(() => request<{ ok: boolean }>(`/communities/${communityId}/members`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ userId }) })),
  communityInvites: (token: string) => centralOnly(() => request<CommunityInvite[]>("/community-invites", { method: "GET", headers: { authorization: `Bearer ${token}` } })),
  inviteToCommunity: (token: string, communityId: string, email: string) => centralOnly(() => request<{ ok: boolean }>(`/communities/${communityId}/invites`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ email }) })),
  createCommunityInviteLink: (token: string, communityId: string) => centralOnly(() => request<{ token: string; expiresInDays: number }>(`/communities/${communityId}/invites`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ createLink: true }) })),
  acceptCommunityInvite: (token: string, inviteId: string) => centralOnly(() => request<{ communityId: string }>(`/community-invites/${inviteId}/accept`, { method: "POST", headers: { authorization: `Bearer ${token}` } })),
  acceptCommunityInviteLink: (token: string, inviteToken: string) => centralOnly(() => request<{ communityId: string }>(`/invites/${encodeURIComponent(inviteToken)}/accept`, { method: "POST", headers: { authorization: `Bearer ${token}` } })),
  messages: (token: string, channelId: string) => centralOnly(() => request<ChatMessage[]>(`/channels/${channelId}/messages`, { method: "GET", headers: { authorization: `Bearer ${token}` } })),
  sendMessage: (token: string, channelId: string, content: string) => centralOnly(() => request<ChatMessage>(`/channels/${channelId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ content }) })),
  createRoom: (token: string, name: string) => centralOnly(() => request<{ id: string }>("/rooms", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) })),
  turnCredentials,
};
