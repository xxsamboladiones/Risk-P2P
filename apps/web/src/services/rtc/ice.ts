const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
];

export type IceConfigurationSource = "environment" | "fallback-stun";

export type ResolvedIceConfiguration = {
  iceServers: RTCIceServer[];
  source: IceConfigurationSource;
};

export function configuredIceServers(raw = import.meta.env.VITE_ICE_SERVERS_JSON): RTCIceServer[] | null {
  if (!raw?.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("VITE_ICE_SERVERS_JSON precisa conter JSON válido.");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("VITE_ICE_SERVERS_JSON precisa ser um array não vazio de servidores ICE.");
  }
  return validateIceServers(value);
}

export function validateIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw new Error("A configuração ICE precisa ter entre 1 e 12 servidores.");
  }
  return value.map(validateIceServer);
}

export function resolveStaticIceConfiguration(raw = import.meta.env.VITE_ICE_SERVERS_JSON): ResolvedIceConfiguration {
  const configured = configuredIceServers(raw);
  if (configured) return { iceServers: configured, source: "environment" };
  return { iceServers: DEFAULT_STUN_SERVERS.map(cloneIceServer), source: "fallback-stun" };
}

function validateIceServer(value: unknown): RTCIceServer {
  if (!value || typeof value !== "object") throw new Error("Servidor ICE inválido.");
  const item = value as Record<string, unknown>;
  const urls = normalizeUrls(item.urls);
  const username = typeof item.username === "string" ? item.username : undefined;
  const credential = typeof item.credential === "string" ? item.credential : undefined;
  if (urls.some((url) => /^turns?:/i.test(url))) {
    if (!username || !credential) {
      throw new Error("Servidores TURN configurados no frontend precisam de username e credential.");
    }
  }
  return { urls, username, credential };
}

function normalizeUrls(value: unknown): string[] {
  const rawUrls = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : null;
  const urls = rawUrls?.map((url) => url.trim());
  if (!urls?.length || urls.length > 12 || urls.some((url) => url.length > 512 || !/^(stun|stuns|turn|turns):/i.test(url))) {
    throw new Error("Servidor ICE precisa usar URL stun:, stuns:, turn: ou turns:.");
  }
  return urls;
}

function cloneIceServer(server: RTCIceServer): RTCIceServer {
  return {
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    username: server.username,
    credential: server.credential,
  };
}
