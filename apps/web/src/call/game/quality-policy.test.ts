import { describe, expect, it } from "vitest";
import type { PeerConnectionDiagnostics } from "@risk/rtc";
import { gameQuality } from "./quality-policy";

const healthy = { peerId: "peer", connectionState: "connected", roundTripTimeMs: 25, availableOutgoingKbps: 14000, videoEncodeMs: 5, jitterMs: 2, packetLossPercent: 0 } as PeerConnectionDiagnostics;
describe("qualidade para jogo de baixa latência", () => {
  it("não sobe resolução sem medir a capacidade da conexão e do encoder", () => {
    expect(gameQuality("720p60", [])).toBe("720p60");
    expect(gameQuality("720p60", [{ ...healthy, availableOutgoingKbps: undefined }])).toBe("720p60");
    expect(gameQuality("720p60", [{ ...healthy, videoEncodeMs: undefined }])).toBe("720p60");
    expect(gameQuality("720p60", [healthy])).toBe("1080p60");
  });
  it("reduz resolução quando falta banda, CPU ou cresce o atraso", () => {
    for (const degraded of [{ availableOutgoingKbps: 7000 }, { videoEncodeMs: 22 }, { roundTripTimeMs: 120 }, { packetLossPercent: 3 }]) {
      expect(gameQuality("1080p60", [{ ...healthy, ...degraded }])).toBe("720p60");
    }
    expect(gameQuality("1080p60", [healthy, healthy, healthy])).toBe("720p60");
  });
  it("mantém a qualidade na faixa intermediária para evitar alternância contínua", () => {
    const intermediate = [{ ...healthy, availableOutgoingKbps: 11000 }];
    expect(gameQuality("720p60", intermediate)).toBe("720p60");
    expect(gameQuality("1080p60", intermediate)).toBe("1080p60");
  });
});
