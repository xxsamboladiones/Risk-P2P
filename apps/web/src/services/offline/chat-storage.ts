export type LocalChatMessage = {
  id: string;
  channelId: string;
  author: string;
  content: string;
  createdAt: string;
  authorPeerId?: string | null;
  signature?: string | null;
};

import { OFFLINE_STORES, openRiskDatabase } from "./database";
const STORE = OFFLINE_STORES.messages;
type DesktopBackendConfig = { baseUrl: string; token?: string };
let configPromise: Promise<DesktopBackendConfig | null> | undefined;
const migratedChannels = new Set<string>();
const DEV_BACKEND_PROXY = "/__risk-api";

export type MessagePageOptions = { before?: string; limit?: number };

export async function loadLocalMessages(channelId: string, options: MessagePageOptions = {}): Promise<LocalChatMessage[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
  const config = await desktopConfig();
  if (!config) return loadLegacyMessages(channelId, options.before, limit);
  const query = `?limit=${limit}${options.before ? `&before=${encodeURIComponent(options.before)}` : ""}`;
  const current = await backendRequest<LocalChatMessage[]>(config, channelId, { method: "GET" }, query);
  if (options.before) return current;
  if (!migratedChannels.has(channelId)) {
    migratedChannels.add(channelId);
    const legacy = await loadLegacyMessages(channelId, undefined, 200);
    const missing = legacy.filter((message) => !current.some((item) => item.id === message.id));
    for (const message of missing) {
      await backendRequest(config, channelId, { method: "POST", body: JSON.stringify(message) });
    }
    if (missing.length) return backendRequest<LocalChatMessage[]>(config, channelId, { method: "GET" }, query);
  }
  return current;
}

export async function saveLocalMessage(message: LocalChatMessage): Promise<void> {
  const config = await desktopConfig();
  if (config) {
    await backendRequest(config, message.channelId, { method: "POST", body: JSON.stringify(message) });
    return;
  }
  await saveLegacyMessage(message);
}

async function desktopConfig(): Promise<DesktopBackendConfig | null> {
  if (window.desktop?.getBackendConfig) {
    if (!configPromise) {
      configPromise = window.desktop.getBackendConfig()
        .then((config) => ({ baseUrl: config.baseUrl.replace(/\/$/, ""), token: config.token }))
        .catch((error) => {
          configPromise = undefined;
          throw error;
        });
    }
    return configPromise;
  }

  if (import.meta.env.DEV && import.meta.env.VITE_API_URL === DEV_BACKEND_PROXY) {
    return { baseUrl: DEV_BACKEND_PROXY };
  }

  return null;
}

async function backendRequest<T>(config: DesktopBackendConfig, channelId: string, init: RequestInit, query = ""): Promise<T> {
  const perform = async (accessToken: string | null) => {
    const headers = new Headers({ "content-type": "application/json", ...init.headers });
    if (config.token) headers.set("x-risk-desktop-token", config.token);
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    return fetch(`${config.baseUrl}/p2p/messages/${encodeURIComponent(channelId)}${query}`, { ...init, headers });
  };
  let accessToken = sessionStorage.getItem("accessToken");
  let response = await perform(accessToken);
  if (response.status === 401) {
    const refreshHeaders = new Headers();
    if (config.token) refreshHeaders.set("x-risk-desktop-token", config.token);
    const refresh = await fetch(`${config.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: refreshHeaders,
    });
    if (refresh.ok) {
      const session = await refresh.json() as { accessToken: string };
      sessionStorage.setItem("accessToken", session.accessToken);
      accessToken = session.accessToken;
      response = await perform(accessToken);
    }
  }
  const body = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `Falha no histórico SQLite (HTTP ${response.status}).`);
  return body;
}

async function loadLegacyMessages(channelId: string, before: string | undefined, limit: number): Promise<LocalChatMessage[]> {
  const database = await openRiskDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const index = transaction.objectStore(STORE).index("channelId");
    const request = index.getAll(IDBKeyRange.only(channelId));
    request.onsuccess = () => resolve((request.result as LocalChatMessage[])
      .filter((message) => !before || message.createdAt < before)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit));
    request.onerror = () => reject(request.error ?? new Error("Falha ao ler o histórico local."));
    transaction.oncomplete = () => database.close();
  });
}

async function saveLegacyMessage(message: LocalChatMessage): Promise<void> {
  const database = await openRiskDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(message);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Falha ao salvar a mensagem local.")); };
  });
}
