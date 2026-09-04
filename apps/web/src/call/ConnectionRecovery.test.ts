import { describe, expect, it } from "vitest";
import { ConnectionRecovery } from "./ConnectionRecovery";

describe("ConnectionRecovery", () => {
  it("mantém o aviso enquanto outro peer ainda está em recuperação", () => {
    const recovery = new ConnectionRecovery();
    recovery.begin(false, [{ provider: "zerotier" }]);
    const message = recovery.failed("peer-b");
    recovery.failed("peer-c");

    expect(message).toContain("ZeroTier");
    expect(recovery.finish("peer-b", message)).toBe(false);
    expect(recovery.finish("peer-c", message)).toBe(true);
  });

  it("não apaga um erro mais recente e não relacionado", () => {
    const recovery = new ConnectionRecovery();
    recovery.begin(false, []);
    recovery.failed("peer-b");
    expect(recovery.finish("peer-b", "Falha ao abrir o microfone.")).toBe(false);
  });
});
