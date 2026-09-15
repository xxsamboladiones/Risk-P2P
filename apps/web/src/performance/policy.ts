export type ExecutionMode = "foreground" | "foreground-call" | "background-call" | "idle-hidden";
export type MediaPressure = "normal" | "warning" | "overloaded";
export type RuntimeActivity = {
  callActive: boolean;
  transferActive: boolean;
  screenPublicationActive: boolean;
  gameSessionActive: boolean;
};
export type PerformanceSignals = {
  documentVisible: boolean;
  callWorkspaceVisible: boolean;
  mediaPressure: MediaPressure;
  activity: RuntimeActivity;
};
export type PerformancePolicy = {
  mode: ExecutionMode;
  mediaPressure: MediaPressure;
  hasCriticalBackgroundWork: boolean;
  visualVoiceActivityEnabled: boolean;
  hiddenVideoPresentationEnabled: boolean;
  diagnosticsIntervalMs: number | null;
  chromiumBackgroundThrottlingAllowed: boolean;
};

export function derivePerformancePolicy(signals: PerformanceSignals): PerformancePolicy {
  const hasCriticalBackgroundWork = Object.values(signals.activity).some(Boolean);
  const mode: ExecutionMode = signals.documentVisible && signals.callWorkspaceVisible
    ? "foreground-call"
    : signals.activity.callActive
      ? "background-call"
      : signals.documentVisible ? "foreground" : "idle-hidden";

  return {
    mode,
    mediaPressure: signals.mediaPressure,
    hasCriticalBackgroundWork,
    visualVoiceActivityEnabled: mode === "foreground-call",
    hiddenVideoPresentationEnabled: mode === "foreground-call",
    diagnosticsIntervalMs: mode === "foreground-call" ? 3_000 : mode === "background-call" ? 10_000 : null,
    chromiumBackgroundThrottlingAllowed: !hasCriticalBackgroundWork,
  };
}
