import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopGameBackend } from "./DesktopGameBackend";

vi.mock("../../services/offline/desktop-backend-client", () => ({ desktopConfig: async () => ({ baseUrl: "http://127.0.0.1:3333", token: "local-token" }) }));
afterEach(() => vi.unstubAllGlobals());
describe("autenticação do backend de jogo", () => {
  it("renova o token vencido uma única vez para requisições simultâneas", async () => {
    let token = "expired";
    vi.stubGlobal("sessionStorage", { getItem: () => token, setItem: (_: string, value: string) => { token = value; } });
    let refreshes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/auth/refresh")) { refreshes++; await new Promise((done) => setTimeout(done, 10)); return Response.json({ accessToken: "renewed" }); }
      if ((init.headers as Record<string, string>).authorization !== "Bearer renewed") return Response.json({ message: "expired" }, { status: 401 });
      return Response.json({ players: ["grant"] });
    }));
    const backend = new DesktopGameBackend();
    const results = await Promise.all([backend.request("heartbeat"), backend.request("heartbeat")]);
    expect(results).toEqual([{ players: ["grant"] }, { players: ["grant"] }]);
    expect(refreshes).toBe(1);
    expect(token).toBe("renewed");
  });
});
