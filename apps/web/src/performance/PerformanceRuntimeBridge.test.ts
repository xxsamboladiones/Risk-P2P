import { expect, it, vi } from "vitest";
import { PerformanceCoordinator } from "./coordinator";
import {
  createDesktopPerformancePolicyBridge,
  observeDesktopWindowVisibility,
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

it("uses native hide and restore events without letting a late initial read overwrite them", async () => {
  let resolveInitial!: (value: boolean) => void;
  const initialVisibility = new Promise<boolean>((resolve) => { resolveInitial = resolve; });
  let emitVisibility!: (value: unknown) => void;
  const unsubscribe = vi.fn();
  const coordinator = new PerformanceCoordinator();
  coordinator.update({
    documentVisible: true,
    callWorkspaceVisible: true,
    activity: {
      callActive: true,
      transferActive: false,
      screenPublicationActive: false,
      gameSessionActive: false,
    },
  });

  const stop = observeDesktopWindowVisibility(() => ({
    getWindowVisibility: () => initialVisibility,
    onWindowVisibilityChanged: (callback) => {
      emitVisibility = callback;
      return unsubscribe;
    },
  }), (visible) => coordinator.update({ documentVisible: visible }));

  emitVisibility("false");
  expect(coordinator.getSnapshot().mode).toBe("foreground-call");
  emitVisibility(false);
  expect(coordinator.getSnapshot()).toMatchObject({
    mode: "background-call",
    chromiumBackgroundThrottlingAllowed: false,
  });

  resolveInitial(true);
  await initialVisibility;
  await Promise.resolve();
  expect(coordinator.getSnapshot().mode).toBe("background-call");

  emitVisibility(true);
  expect(coordinator.getSnapshot()).toMatchObject({
    mode: "foreground-call",
    chromiumBackgroundThrottlingAllowed: false,
  });

  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("keeps document visibility when the desktop visibility API is missing", () => {
  const observed: boolean[] = [];
  const stop = observeDesktopWindowVisibility(() => undefined, (visible) => observed.push(visible));

  expect(observed).toEqual([]);
  expect(() => stop()).not.toThrow();
});
