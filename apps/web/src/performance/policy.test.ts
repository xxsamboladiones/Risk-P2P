import { describe, expect, it } from "vitest";
import { derivePerformancePolicy, type PerformanceSignals } from "./policy";

const base: PerformanceSignals = {
  documentVisible: true,
  callWorkspaceVisible: false,
  mediaPressure: "normal",
  activity: {
    callActive: false,
    transferActive: false,
    screenPublicationActive: false,
    gameSessionActive: false,
  },
};

describe("performance policy", () => {
  it.each([
    [{}, "foreground"],
    [{ callWorkspaceVisible: true, activity: { ...base.activity, callActive: true } }, "foreground-call"],
    [{ documentVisible: false, activity: { ...base.activity, callActive: true } }, "background-call"],
    [{ documentVisible: false }, "idle-hidden"],
  ] as const)("derives the execution mode for %j", (patch, mode) => {
    expect(derivePerformancePolicy({ ...base, ...patch }).mode).toBe(mode);
  });

  it("keeps a hidden transfer schedulable without inventing a new mode", () => {
    const policy = derivePerformancePolicy({
      ...base,
      documentVisible: false,
      activity: { ...base.activity, transferActive: true },
    });
    expect(policy.mode).toBe("idle-hidden");
    expect(policy.hasCriticalBackgroundWork).toBe(true);
    expect(policy.chromiumBackgroundThrottlingAllowed).toBe(false);
  });
});
