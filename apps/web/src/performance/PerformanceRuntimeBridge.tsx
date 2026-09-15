import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRiskApplication } from "../application/ApplicationContext";
import { useCallStore } from "../store";
import type { PerformancePolicy, PerformanceSignals, RuntimeActivity } from "./policy";

type PerformanceUiSnapshot = {
  documentVisible: boolean;
  callWorkspaceOpen: boolean;
  roomId: string | null;
  screenShare: boolean;
  gameSessionActive: boolean;
  trackedActivity: RuntimeActivity;
};

type UiPerformanceSignals = Pick<
  PerformanceSignals,
  "documentVisible" | "callWorkspaceVisible" | "activity"
>;

export function performanceSignalsFromUi(input: PerformanceUiSnapshot): UiPerformanceSignals {
  return {
    documentVisible: input.documentVisible,
    callWorkspaceVisible: input.callWorkspaceOpen,
    activity: {
      callActive: Boolean(input.roomId) || input.trackedActivity.callActive,
      transferActive: input.trackedActivity.transferActive,
      screenPublicationActive: input.screenShare || input.trackedActivity.screenPublicationActive,
      gameSessionActive: input.gameSessionActive || input.trackedActivity.gameSessionActive,
    },
  };
}

const getDocumentVisible = () => document.visibilityState === "visible";

const subscribeDocumentVisibility = (listener: () => void): (() => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

type DesktopPerformancePolicyApi = {
  setPerformancePolicy?(policy: {
    chromiumBackgroundThrottlingAllowed: boolean;
  }): Promise<void>;
};

export function createDesktopPerformancePolicyBridge(
  resolveDesktop: () => DesktopPerformancePolicyApi | undefined = () => window.desktop,
): (chromiumBackgroundThrottlingAllowed: boolean) => void {
  let previousPermission: boolean | undefined;
  return (chromiumBackgroundThrottlingAllowed) => {
    if (previousPermission === chromiumBackgroundThrottlingAllowed) return;
    previousPermission = chromiumBackgroundThrottlingAllowed;
    void resolveDesktop()?.setPerformancePolicy?.({ chromiumBackgroundThrottlingAllowed });
  };
}

export function usePerformancePolicy(): PerformancePolicy {
  const { performance } = useRiskApplication();
  return useSyncExternalStore(performance.subscribe, performance.getSnapshot);
}

export function PerformanceRuntimeBridge() {
  const { call, performance, performanceActivity } = useRiskApplication();
  const documentVisible = useSyncExternalStore(subscribeDocumentVisibility, getDocumentVisible);
  const callState = useSyncExternalStore(useCallStore.subscribe, useCallStore.getState);
  const gameState = useSyncExternalStore(call.game.subscribe, call.game.getSnapshot);
  const trackedActivity = useSyncExternalStore(
    performanceActivity.subscribe,
    performanceActivity.getSnapshot,
  );
  const policy = useSyncExternalStore(performance.subscribe, performance.getSnapshot);
  const desktopPerformancePolicyBridge = useMemo(createDesktopPerformancePolicyBridge, []);

  const gameSessionActive = Boolean(gameState.host || gameState.playing);

  useEffect(() => {
    performance.update(performanceSignalsFromUi({
      documentVisible,
      callWorkspaceOpen: callState.callWorkspaceOpen,
      roomId: callState.roomId,
      screenShare: callState.localState.screenShare,
      gameSessionActive,
      trackedActivity,
    }));
  }, [
    callState.callWorkspaceOpen,
    callState.localState.screenShare,
    callState.roomId,
    documentVisible,
    gameSessionActive,
    performance,
    trackedActivity,
  ]);

  useEffect(() => {
    desktopPerformancePolicyBridge(policy.chromiumBackgroundThrottlingAllowed);
  }, [
    desktopPerformancePolicyBridge,
    policy.chromiumBackgroundThrottlingAllowed,
  ]);

  return null;
}
