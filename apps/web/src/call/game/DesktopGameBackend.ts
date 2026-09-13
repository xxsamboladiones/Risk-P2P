import type { GameDevice, GameInputFrame } from "@risk/protocol";
import { desktopConfig } from "../../services/offline/desktop-backend-client";

export type GameCapabilities = { keyboardMouse: boolean; gamepad: boolean; reason?: string };
export interface GameBackend {
  request<T>(operation: string, body?: Record<string, unknown>): Promise<T>;
  input(peerId: string, frame: GameInputFrame): Promise<void>;
}
export class GameBackendError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function isPermanentGameError(error: unknown): boolean {
  return error instanceof GameBackendError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}
export class DesktopGameBackend implements GameBackend {
  private refreshing?: Promise<void>;
  async request<T>(operation: string, body?: Record<string, unknown>): Promise<T> {
    return this.fetch(operation === "capabilities" ? "capabilities" : "command", operation === "capabilities" ? undefined : { op: operation, ...body });
  }
  async input(peerId: string, frame: GameInputFrame): Promise<void> { await this.fetch("input", { peerId, frame }); }
  private async fetch<T>(path: string, body?: unknown): Promise<T> {
    const config = await desktopConfig();
    if (!config?.token) throw new Error("Hospedar Modo Jogo requer o aplicativo desktop atualizado.");
    const perform = (accessToken: string | null) => fetch(`${config.baseUrl}/game/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-risk-desktop-token": config.token!, authorization: `Bearer ${accessToken ?? ""}` },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(1500),
    });
    const accessToken = sessionStorage.getItem("accessToken");
    let response = await perform(accessToken);
    if (response.status === 401) {
      if (sessionStorage.getItem("accessToken") === accessToken) {
        this.refreshing ??= (async () => {
          const refresh = await fetch(`${config.baseUrl}/auth/refresh`, {
            method: "POST", headers: { "x-risk-desktop-token": config.token! }, signal: AbortSignal.timeout(1500),
          });
          if (!refresh.ok) throw new GameBackendError("Não foi possível renovar a sessão de jogo.", refresh.status);
          const session = await refresh.json() as { accessToken: string };
          sessionStorage.setItem("accessToken", session.accessToken);
        })().finally(() => { this.refreshing = undefined; });
        await this.refreshing;
      }
      response = await perform(sessionStorage.getItem("accessToken"));
    }
    const value = await response.json();
    if (!response.ok) throw new GameBackendError(value.message ?? "Backend de jogo indisponível. Atualize o aplicativo desktop.", response.status);
    return value as T;
  }
}
export type GamePlayer = { peerId: string; grantId: string; device: GameDevice; slot: number; requestId: string };
