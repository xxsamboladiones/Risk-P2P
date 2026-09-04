import { describe, expect, it } from "vitest";
import type { StatsReportLike } from "../connection-path";
import { summarizePeerStats } from "./stats";

function reports(...values: Array<Record<string, unknown>>): StatsReportLike {
  return new Map(values.map((value, index) => [String(value.id ?? index), value])) as unknown as StatsReportLike;
}

describe("summarizePeerStats", () => {
  it("calculates packet loss percentage across inbound reports", () => {
    const result = summarizePeerStats(reports(
      { id: "audio", type: "inbound-rtp", kind: "audio", packetsLost: 5, packetsReceived: 45 },
      { id: "video", type: "inbound-rtp", kind: "video", packetsLost: 5, packetsReceived: 45 },
    ), undefined, []);

    expect(result.packetsLost).toBe(10);
    expect(result.packetLossPercent).toBe(10);
  });

  it("normalizes Chromium negative packet-loss corrections instead of reporting a negative percentage", () => {
    const result = summarizePeerStats(reports(
      { id: "audio", type: "inbound-rtp", kind: "audio", packetsLost: -2, packetsReceived: 50 },
    ), undefined, []);

    expect(result.packetsLost).toBe(0);
    expect(result.packetLossPercent).toBe(0);
  });
});
