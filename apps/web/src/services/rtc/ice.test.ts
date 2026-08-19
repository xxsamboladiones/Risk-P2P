import { describe, expect, it } from "vitest";
import { configuredIceServers, resolveStaticIceConfiguration } from "./ice";

describe("configuração ICE local", () => {
  it("usa STUN de fallback quando não há configuração", () => {
    const result = resolveStaticIceConfiguration("");
    expect(result.source).toBe("fallback-stun");
    expect(result.iceServers.length).toBeGreaterThan(0);
    expect(String(Array.isArray(result.iceServers[0]?.urls) ? result.iceServers[0]?.urls[0] : result.iceServers[0]?.urls)).toMatch(/^stun:/);
  });

  it("aceita configuração ICE fornecida no build", () => {
    const servers = configuredIceServers(JSON.stringify([
      { urls: ["stun:example.test:3478"] },
      { urls: "turn:example.test:3478?transport=udp", username: "user", credential: "pass" },
    ]));
    expect(servers).toHaveLength(2);
    expect(servers?.[1]?.username).toBe("user");
  });

  it("rejeita TURN sem credenciais e protocolos inválidos", () => {
    expect(() => configuredIceServers('[{"urls":"turn:example.test:3478"}]')).toThrow(/username/);
    expect(() => configuredIceServers('[{"urls":"https://example.test"}]')).toThrow(/stun/);
  });
});
