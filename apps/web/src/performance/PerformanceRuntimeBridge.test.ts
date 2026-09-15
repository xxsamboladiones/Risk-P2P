import { expect, it } from "vitest";
import { performanceSignalsFromUi } from "./PerformanceRuntimeBridge";

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
