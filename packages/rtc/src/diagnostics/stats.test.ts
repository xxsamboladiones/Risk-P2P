import { describe, expect, it } from "vitest";
import type { StatsReportLike } from "../connection-path";
import { summarizePeerStats } from "./stats";

function reports(...values: Array<Record<string, unknown>>): StatsReportLike {
  return new Map(values.map((value, index) => [String(value.id ?? index), value])) as unknown as StatsReportLike;
}

describe("summarizePeerStats", () => {
  it("reports encoding cost and send capacity without assuming missing measurements are healthy", () => {
    const result = summarizePeerStats(reports(
      { id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, availableOutgoingBitrate: 12_000_000 },
      { id: "video", type: "outbound-rtp", kind: "video", bytesSent: 100, framesEncoded: 10, totalEncodeTime: 0.25 },
    ), undefined, []);
    expect(result.videoEncodeMs).toBe(25);
    expect(result.availableOutgoingKbps).toBe(12000);
    const missing = summarizePeerStats(reports(), undefined, []);
    expect(missing.videoEncodeMs).toBeUndefined();
    expect(missing.availableOutgoingKbps).toBeUndefined();
  });
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
