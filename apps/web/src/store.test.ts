import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("useCallStore sem Web Storage", () => {
  it("pode ser importado e mantém a sessão em memória no ambiente Node", async () => {
    vi.stubGlobal("sessionStorage", undefined);
    vi.resetModules();

    const { useCallStore } = await import("./store");

    expect(useCallStore.getState().token).toBeNull();
    expect(() => useCallStore.getState().setSession("token-ci")).not.toThrow();
    expect(useCallStore.getState().token).toBe("token-ci");
    expect(() => useCallStore.getState().reset()).not.toThrow();
    expect(useCallStore.getState().token).toBeNull();
  });
});
