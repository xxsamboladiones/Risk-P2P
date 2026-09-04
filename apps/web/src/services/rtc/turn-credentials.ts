import { validateIceServers } from "./ice";

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

export type TemporaryTurnCredentials = {
  iceServers: RTCIceServer[];
  username: string;
  credential: string;
  ttl: number;
  expiresAt: number;
  urls: string[];
};

type TurnCredentialClientOptions = {
  allowInsecureLoopback?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
};

type CachedCredentials = {
  accessToken?: string;
  value: TemporaryTurnCredentials;
};

export class TemporaryTurnCredentialClient {
  readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private cached?: CachedCredentials;
  private inFlight?: { accessToken?: string; request: Promise<TemporaryTurnCredentials> };

  constructor(endpoint: string, options: TurnCredentialClientOptions = {}) {
    this.endpoint = validateTurnCredentialsEndpoint(endpoint, options.allowInsecureLoopback === true);
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  reset(): void {
    this.cached = undefined;
    this.inFlight = undefined;
  }

  async get(accessToken?: string): Promise<TemporaryTurnCredentials> {
    const cached = this.cached;
    if (cached && cached.accessToken === accessToken && credentialsAreFresh(cached.value, this.now())) {
      return cloneCredentials(cached.value);
    }
    const inFlight = this.inFlight;
    if (inFlight && inFlight.accessToken === accessToken) return inFlight.request.then(cloneCredentials);

    const request = this.fetch(accessToken).finally(() => {
      if (this.inFlight?.request === request) this.inFlight = undefined;
    });
    this.inFlight = { accessToken, request };
    const value = await request;
    this.cached = { accessToken, value };
    return cloneCredentials(value);
  }

  private async fetch(accessToken?: string): Promise<TemporaryTurnCredentials> {
    const headers = new Headers({ accept: "application/json" });
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    const response = await this.fetcher(this.endpoint, {
      method: "GET",
      headers,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `O emissor TURN respondeu HTTP ${response.status}.`;
      throw new Error(message);
    }
    return parseTemporaryTurnCredentials(body, this.now());
  }
}

export function validateTurnCredentialsEndpoint(raw: string, allowInsecureLoopback = false): string {
  const value = raw.trim();
  if (!value) throw new Error("VITE_TURN_CREDENTIALS_URL não pode ficar vazia.");
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw new Error("VITE_TURN_CREDENTIALS_URL precisa ser uma URL válida."); }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(allowInsecureLoopback && endpoint.protocol === "http:" && loopback)) {
    throw new Error("O emissor de credenciais TURN precisa usar HTTPS.");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("A URL do emissor TURN não pode conter credenciais nem fragmento.");
  }
  return endpoint.toString();
}

export function parseTemporaryTurnCredentials(value: unknown, nowMs = Date.now()): TemporaryTurnCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("O emissor TURN retornou um documento inválido.");
  }
  const item = value as Record<string, unknown>;
  const ttl = numberInRange(item.ttl, MIN_TTL_SECONDS, MAX_TTL_SECONDS, "ttl");
  const nowSeconds = Math.floor(nowMs / 1000);
  const declaredExpiry = item.expiresAt === undefined
    ? nowSeconds + ttl
    : numberInRange(item.expiresAt, nowSeconds + 1, nowSeconds + MAX_TTL_SECONDS, "expiresAt");
  const expiresAt = Math.min(declaredExpiry, nowSeconds + ttl);

  const iceServers = item.iceServers === undefined
    ? iceServersFromCompactResponse(item)
    : validateIceServers(item.iceServers);
  const turnServer = iceServers.find((server) => normalizedServerUrls(server).some(isTurnUrl));
  if (!turnServer || typeof turnServer.username !== "string" || typeof turnServer.credential !== "string") {
    throw new Error("O emissor não forneceu um servidor TURN com credenciais temporárias.");
  }
  const urls = iceServers.flatMap(normalizedServerUrls).filter(isTurnUrl);
  const username = typeof item.username === "string" ? item.username : turnServer.username;
  const credential = typeof item.credential === "string" ? item.credential : turnServer.credential;
  if (!username.trim() || username.length > 256 || !credential || credential.length > 512) {
    throw new Error("O emissor TURN retornou username ou credential inválido.");
  }
  if (turnServer.username !== username || turnServer.credential !== credential) {
    throw new Error("Os metadados e o servidor TURN usam credenciais diferentes.");
  }
  return { iceServers, username, credential, ttl, expiresAt, urls };
}

function iceServersFromCompactResponse(item: Record<string, unknown>): RTCIceServer[] {
  const urls = stringList(item.urls, "urls");
  const username = typeof item.username === "string" ? item.username : "";
  const credential = typeof item.credential === "string" ? item.credential : "";
  return validateIceServers([{ urls, username, credential }]);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`O emissor TURN precisa fornecer ${field} como uma lista não vazia.`);
  }
  return value as string[];
}

function numberInRange(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`O emissor TURN retornou ${field} inválido.`);
  }
  return value;
}

function normalizedServerUrls(server: RTCIceServer): string[] {
  return typeof server.urls === "string" ? [server.urls] : [...server.urls];
}

function isTurnUrl(url: string): boolean {
  return /^turns?:/i.test(url);
}

function credentialsAreFresh(value: TemporaryTurnCredentials, nowMs: number): boolean {
  const refreshMarginMs = Math.min(60_000, Math.max(5_000, value.ttl * 100));
  return value.expiresAt * 1000 - nowMs > refreshMarginMs;
}

function cloneCredentials(value: TemporaryTurnCredentials): TemporaryTurnCredentials {
  return {
    ...value,
    urls: [...value.urls],
    iceServers: value.iceServers.map((server) => ({
      urls: typeof server.urls === "string" ? server.urls : [...server.urls],
      username: server.username,
      credential: server.credential,
    })),
  };
}
