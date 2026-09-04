export const P2P_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
export const P2P_CLOCK_SKEW_WARNING_MS = 30_000;

export function p2pClockSkewMs(timestamp: unknown, now = Date.now()): number | null {
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp - now
    : null;
}

export function withinP2PClockTolerance(timestamp: unknown, now = Date.now()): timestamp is number {
  const skew = p2pClockSkewMs(timestamp, now);
  return skew !== null && Math.abs(skew) <= P2P_CLOCK_SKEW_TOLERANCE_MS;
}
