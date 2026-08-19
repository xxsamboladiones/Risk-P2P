const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
export class ApiRequestError extends Error { constructor(message: string, public readonly status: number) { super(message); } }
async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new ApiRequestError(body.message ?? "A operação falhou", response.status);
  return body;
}
export const api = {
  register: (displayName: string, email: string, password: string) => request<{ accessToken: string }>("/auth/register", { method: "POST", body: JSON.stringify({ displayName, email, password }) }),
  login: (email: string, password: string) => request<{ accessToken: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  createRoom: (token: string, name: string) => request<{ id: string }>("/rooms", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) }),
  turnCredentials: (token: string) => request<{ iceServers: RTCIceServer[] }>("/rtc/credentials", { method: "GET", headers: { authorization: `Bearer ${token}` } })
};
