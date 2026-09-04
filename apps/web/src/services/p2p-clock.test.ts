import { describe, expect, it } from "vitest";
import {
  P2P_CLOCK_SKEW_TOLERANCE_MS,
  p2pClockSkewMs,
  withinP2PClockTolerance,
} from "./p2p-clock";

describe("tolerância de relógio P2P", () => {
  const now = 1_800_000_000_000;

  it("aceita peers adiantados ou atrasados em até cinco minutos", () => {
    expect(withinP2PClockTolerance(now - P2P_CLOCK_SKEW_TOLERANCE_MS, now)).toBe(true);
    expect(withinP2PClockTolerance(now + P2P_CLOCK_SKEW_TOLERANCE_MS, now)).toBe(true);
  });

  it("recusa timestamps inválidos ou fora da tolerância", () => {
    expect(withinP2PClockTolerance(now - P2P_CLOCK_SKEW_TOLERANCE_MS - 1, now)).toBe(false);
    expect(withinP2PClockTolerance(Number.NaN, now)).toBe(false);
    expect(p2pClockSkewMs(now + 42_000, now)).toBe(42_000);
  });
});
