const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
export class ApiRequestError extends Error { constructor(message: string, public readonly status: number) { super(message); } }
export type Friend = { id: string; displayName: string; local?: boolean };
export type PendingFriend = Friend & { requestId: string };
export type Community = { id: string; name: string; local?: boolean };
export type Channel = { id: string; name: string; kind: "text" | "voice"; voiceRoomId?: string | null };
export type ChatMessage = { id: string; author: string; content: string; createdAt: string };
export type CommunityInvite = { id: string; communityId: string; communityName: string; inviter: string };
export type CurrentUser = { id: string; displayName: string; email: string };
async function request<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers({ "content-type": "application/json", ...init.headers });
  if (headers.has("authorization")) { const current = sessionStorage.getItem("accessToken"); if (current) headers.set("authorization", `Bearer ${current}`); }
  let response = await fetch(`${API_URL}${path}`, { ...init, credentials: "include", headers });
  if (response.status === 401 && path !== "/auth/refresh") {
    const refreshed = await fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) { const session = await refreshed.json() as { accessToken: string }; sessionStorage.setItem("accessToken", session.accessToken); headers.set("authorization", `Bearer ${session.accessToken}`); response = await fetch(`${API_URL}${path}`, { ...init, credentials: "include", headers }); }
  }
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new ApiRequestError(body.message ?? "A operação falhou", response.status);
  return body;
}
export const api = {
  register: (displayName: string, email: string, password: string) => request<{ accessToken: string }>("/auth/register", { method: "POST", body: JSON.stringify({ displayName, email, password }) }),
  login: (email: string, password: string) => request<{ accessToken: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  refresh: () => request<{ accessToken: string }>("/auth/refresh", { method: "POST" }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: (token: string) => request<CurrentUser>("/me", { method: "GET", headers: { authorization: `Bearer ${token}` } }),
  friends: (token: string) => request<{ friends: Friend[]; pending: PendingFriend[] }>("/friends", { method: "GET", headers: { authorization: `Bearer ${token}` } }),
  addFriend: (token: string, email: string) => request<{ ok: boolean }>("/friends/requests", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ email }) }),
  acceptFriend: (token: string, requestId: string) => request<{ ok: boolean }>(`/friends/requests/${requestId}/accept`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
  communities: (token: string) => request<Community[]>("/communities", { method: "GET", headers: { authorization: `Bearer ${token}` } }),
  createCommunity: (token: string, name: string) => request<Community>("/communities", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) }),
  addCommunityMember: (token: string, communityId: string, userId: string) => request<{ ok: boolean }>(`/communities/${communityId}/members`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ userId }) }),
  communityInvites: (token: string) => request<CommunityInvite[]>("/community-invites", { method: "GET", headers: { authorization: `Bearer ${token}` } }),
  inviteToCommunity: (token: string, communityId: string, email: string) => request<{ ok: boolean }>(`/communities/${communityId}/invites`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ email }) }),
  createCommunityInviteLink: (token: string, communityId: string) => request<{ token: string; expiresInDays: number }>(`/communities/${communityId}/invites`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ createLink: true }) }),
  acceptCommunityInvite: (token: string, inviteId: string) => request<{ communityId: string }>(`/community-invites/${inviteId}/accept`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
  acceptCommunityInviteLink: (token: string, inviteToken: string) => request<{ communityId: string }>(`/invites/${encodeURIComponent(inviteToken)}/accept`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
  channels: (token: string, communityId: string) => request<Channel[]>(`/communities/${communityId}/channels`, { method: "GET", headers: { authorization: `Bearer ${token}` } }),
  createChannel: (token: string, communityId: string, name: string, kind: "text" | "voice") => request<Channel>(`/communities/${communityId}/channels`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name, kind }) }),
  messages: (token: string, channelId: string) => request<ChatMessage[]>(`/channels/${channelId}/messages`, { method: "GET", headers: { authorization: `Bearer ${token}` } }),
  sendMessage: (token: string, channelId: string, content: string) => request<ChatMessage>(`/channels/${channelId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ content }) }),
  createRoom: (token: string, name: string) => request<{ id: string }>("/rooms", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) }),
  turnCredentials: (token: string) => request<{ iceServers: RTCIceServer[] }>("/rtc/credentials", { method: "GET", headers: { authorization: `Bearer ${token}` } })
};
