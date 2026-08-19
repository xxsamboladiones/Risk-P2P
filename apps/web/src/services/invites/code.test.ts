import { describe, expect, it } from "vitest";
import { deriveInviteRendezvousId, generateRiskInviteCode, InviteAttemptLimiter, normalizeRiskInviteCode, validateRiskInviteCode } from "./code";

describe("códigos de convite Risk", () => {
  it("gera códigos criptográficos no formato amigável e sem caracteres ambíguos", () => {
    const codes = new Set(Array.from({ length: 100 }, generateRiskInviteCode));
    expect(codes.size).toBe(100);
    codes.forEach((code) => expect(code).toMatch(/^risk-(?:[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-){3}[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/));
  });

  it("normaliza caixa, espaços, código cru e deep links futuros", () => {
    expect(normalizeRiskInviteCode(" Risk-7h4k-m9p2-q8rf-a3dx ")).toBe("risk-7H4K-M9P2-Q8RF-A3DX");
    expect(normalizeRiskInviteCode("7h4km9p2q8rfa3dx")).toBe("risk-7H4K-M9P2-Q8RF-A3DX");
    expect(normalizeRiskInviteCode("risk://friend/risk-7h4k-m9p2-q8rf-a3dx")).toBe("risk-7H4K-M9P2-Q8RF-A3DX");
    expect(validateRiskInviteCode("risk-123")).toBe(false);
  });

  it("deriva rendezvous determinístico com namespaces separados", async () => {
    const code = "risk-7H4K-M9P2-Q8RF-A3DX";
    expect(await deriveInviteRendezvousId("friend", code)).toBe(await deriveInviteRendezvousId("friend", code.toLowerCase()));
    expect(await deriveInviteRendezvousId("friend", code)).not.toBe(await deriveInviteRendezvousId("group", code));
  });

  it("limita tentativas locais em uma janela", () => {
    const limiter = new InviteAttemptLimiter(2, 1_000);
    expect(limiter.consume(0)).toBe(true); expect(limiter.consume(10)).toBe(true); expect(limiter.consume(20)).toBe(false); expect(limiter.consume(1_100)).toBe(true);
  });
});
