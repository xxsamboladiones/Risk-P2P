import { describe, expect, it, vi } from "vitest";
import {
  CallTransportRegistry,
  type CallTransport,
  type CallTransportCreationContext,
  type TransportEvents,
} from "@risk/rtc";
import { createCallTransport } from "./transport-factory";

function fakeTransport(kind: "mesh" | "sfu"): CallTransport {
  return { kind } as CallTransport;
}

const events = {
  sendOffer: vi.fn(),
  sendAnswer: vi.fn(),
  sendIce: vi.fn(),
  onRemoteStream: vi.fn(),
  onConnectionState: vi.fn(),
} satisfies TransportEvents;

function context(): CallTransportCreationContext {
  return { localPeerId: "local", iceServers: [], events };
}

describe("registro de CallTransport", () => {
  it("instancia Mesh quando somente o fallback P2P está registrado", () => {
    const mesh = fakeTransport("mesh");
    const registry = new CallTransportRegistry({ mesh: () => mesh });
    const result = createCallTransport({ ...context(), participantCount: 6, registry });
    expect(result.transport).toBe(mesh);
    expect(result.decision).toMatchObject({ selected: "mesh", recommended: "sfu", sfuAvailable: false });
  });

  it("instancia SFU para cinco participantes quando o provedor é registrado", () => {
    const mesh = fakeTransport("mesh");
    const sfu = fakeTransport("sfu");
    const registry = new CallTransportRegistry({ mesh: () => mesh, sfu: () => sfu });
    const result = createCallTransport({ ...context(), participantCount: 5, registry });
    expect(result.transport).toBe(sfu);
    expect(result.decision).toMatchObject({ selected: "sfu", reason: "participant-threshold", sfuAvailable: true });
  });

  it("detecta fábricas registradas com o tipo errado", () => {
    const registry = new CallTransportRegistry({
      mesh: () => fakeTransport("mesh"),
      sfu: () => fakeTransport("mesh"),
    });
    expect(() => createCallTransport({ ...context(), participantCount: 5, registry })).toThrow("incompatível");
  });

  it("entrega a preferência e as interfaces de rede à fábrica Mesh", () => {
    const createMesh = vi.fn(() => fakeTransport("mesh"));
    const registry = new CallTransportRegistry({ mesh: createMesh });
    const networkInterfaces = [{ name: "tailscale0", address: "100.64.0.8", family: "IPv4" as const, provider: "tailscale" as const }];
    createCallTransport({
      ...context(),
      participantCount: 2,
      registry,
      networkInterfaces,
      networkPreference: "private-vpn",
    });
    expect(createMesh).toHaveBeenCalledWith(expect.objectContaining({
      networkInterfaces,
      networkPreference: "private-vpn",
    }));
  });
});
