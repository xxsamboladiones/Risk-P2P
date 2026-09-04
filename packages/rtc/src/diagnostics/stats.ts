import {
  classifySelectedConnectionPath,
  resolveSelectedCandidatePair,
  type NetworkInterfaceDescriptor,
  type SelectedConnectionPath,
  type StatsReportLike,
} from "../connection-path";

export type OutboundBytesSample = { bytes: number; timestamp: number };

export type PeerStatsSummary = {
  roundTripTimeMs?: number;
  packetsLost?: number;
  packetLossPercent?: number;
  jitterMs?: number;
  outboundBitrateKbps?: number;
  outboundSample?: OutboundBytesSample;
  selectedConnectionPath: SelectedConnectionPath;
};

export function summarizePeerStats(
  reports: StatsReportLike,
  previousOutbound: OutboundBytesSample | undefined,
  networkInterfaces: readonly NetworkInterfaceDescriptor[],
): PeerStatsSummary {
  const selectedPair = resolveSelectedCandidatePair(reports);
  let packetsLost: number | undefined;
  let packetsReceived = 0;
  let jitterMs: number | undefined;
  let outboundBitrateKbps: number | undefined;
  let outboundSample: OutboundBytesSample | undefined;
  reports.forEach((report) => {
    const rtcReport = report as typeof report & {
      isRemote?: boolean;
      packetsLost?: number;
      packetsReceived?: number;
      jitter?: number;
      kind?: string;
      bytesSent?: number;
      timestamp?: number;
    };
    if (rtcReport.type === "inbound-rtp" && !rtcReport.isRemote) {
      if (typeof rtcReport.packetsLost === "number") packetsLost = (packetsLost ?? 0) + rtcReport.packetsLost;
      if (typeof rtcReport.packetsReceived === "number") packetsReceived += rtcReport.packetsReceived;
      if (typeof rtcReport.jitter === "number") jitterMs = Math.max(jitterMs ?? 0, Math.round(rtcReport.jitter * 1000));
    }
    if (rtcReport.type === "outbound-rtp" && rtcReport.kind === "video" && typeof rtcReport.bytesSent === "number") {
      const timestamp = Number(rtcReport.timestamp);
      if (previousOutbound && timestamp > previousOutbound.timestamp) {
        outboundBitrateKbps = Math.max(0, Math.round(((rtcReport.bytesSent - previousOutbound.bytes) * 8) / (timestamp - previousOutbound.timestamp)));
      }
      outboundSample = { bytes: rtcReport.bytesSent, timestamp };
    }
  });
  const normalizedPacketsLost = packetsLost === undefined ? undefined : Math.max(0, packetsLost);
  return {
    roundTripTimeMs: typeof selectedPair?.pair.currentRoundTripTime === "number"
      ? Math.round(selectedPair.pair.currentRoundTripTime * 1000)
      : undefined,
    packetsLost: normalizedPacketsLost,
    packetLossPercent: normalizedPacketsLost !== undefined && normalizedPacketsLost + packetsReceived > 0
      ? Math.round((normalizedPacketsLost * 10_000) / (normalizedPacketsLost + packetsReceived)) / 100
      : undefined,
    jitterMs,
    outboundBitrateKbps,
    outboundSample,
    selectedConnectionPath: classifySelectedConnectionPath(selectedPair, networkInterfaces),
  };
}

export function connectionPathSignature(path: SelectedConnectionPath): string {
  return `${path.kind}:${path.provider ?? ""}:${path.protocol ?? ""}`;
}
