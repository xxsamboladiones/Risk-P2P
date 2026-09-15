import { useEffect, useSyncExternalStore } from "react";
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
  useSyncExternalStore(performance.subscribe, performance.getSnapshot);

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

  return null;
}
