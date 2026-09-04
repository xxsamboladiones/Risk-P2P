import { describe, expect, it, vi } from "vitest";
import { SessionService } from "./SessionService";

describe("SessionService", () => {
  it("deduplica restaurações concorrentes e permite uma nova tentativa depois", async () => {
    let resolveRefresh!: (value: { accessToken: string }) => void;
    const refresh = vi.fn()
      .mockImplementationOnce(() => new Promise<{ accessToken: string }>((resolve) => { resolveRefresh = resolve; }))
      .mockResolvedValue({ accessToken: "token-b" });
    const service = new SessionService({ refresh, logout: vi.fn() });

    const first = service.restore();
    const second = service.restore();
    expect(first).toBe(second);
    expect(refresh).toHaveBeenCalledOnce();

    resolveRefresh({ accessToken: "token-a" });
    await expect(first).resolves.toBe("token-a");
    await expect(service.restore()).resolves.toBe("token-b");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("impede restauração após logout até uma autenticação explícita", async () => {
    const logout = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => ({ accessToken: "token-a" }));
    const service = new SessionService({ refresh, logout });

    await service.logout();
    await expect(service.restore()).resolves.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(logout).toHaveBeenCalledOnce();

    service.allowRestore();
    await expect(service.restore()).resolves.toBe("token-a");
  });

  it("ignora uma restauração antiga que termina depois do logout", async () => {
    let resolveOld!: (value: { accessToken: string }) => void;
    const refresh = vi.fn()
      .mockImplementationOnce(() => new Promise<{ accessToken: string }>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ accessToken: "token-new" });
    const service = new SessionService({ refresh, logout: vi.fn(async () => undefined) });

    const oldRestore = service.restore();
    service.suppressRestore();
    service.allowRestore();
    await expect(service.restore()).resolves.toBe("token-new");

    resolveOld({ accessToken: "token-old" });
    await expect(oldRestore).resolves.toBeNull();
    await expect(service.restore()).resolves.toBe("token-new");
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
