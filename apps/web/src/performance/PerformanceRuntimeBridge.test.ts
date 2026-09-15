import { expect, it } from "vitest";
import {
  createDesktopPerformancePolicyBridge,
  performanceSignalsFromUi,
} from "./PerformanceRuntimeBridge";

it("separates call presentation from critical activity", () => {
  expect(performanceSignalsFromUi({
    documentVisible: false,
    callWorkspaceOpen: false,
    roomId: "room",
    screenShare: true,
    gameSessionActive: false,
    trackedActivity: {
      callActive: false,
      transferActive: true,
      screenPublicationActive: false,
      gameSessionActive: false,
    },
  })).toMatchObject({
    documentVisible: false,
    callWorkspaceVisible: false,
    activity: {
      callActive: true,
      transferActive: true,
      screenPublicationActive: true,
      gameSessionActive: false,
    },
  });
});

it("sends the desktop permission only when its boolean value changes", () => {
  const sent: Array<{ chromiumBackgroundThrottlingAllowed: boolean }> = [];
  const bridge = createDesktopPerformancePolicyBridge(() => ({
    setPerformancePolicy: async (policy) => { sent.push(policy); },
  }));

  bridge(true);
  bridge(true);
  bridge(false);
  bridge(false);

  expect(sent).toEqual([
    { chromiumBackgroundThrottlingAllowed: true },
    { chromiumBackgroundThrottlingAllowed: false },
  ]);
});

it("treats a missing desktop policy API as a no-op", () => {
  const bridge = createDesktopPerformancePolicyBridge(() => undefined);

  expect(() => bridge(false)).not.toThrow();
});
