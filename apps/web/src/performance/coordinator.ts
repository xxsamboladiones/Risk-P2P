import {
  derivePerformancePolicy,
  type PerformancePolicy,
  type PerformanceSignals,
} from "./policy";

export class PerformanceCoordinator {
  private signals: PerformanceSignals = {
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

  private policy = derivePerformancePolicy(this.signals);
  private listeners = new Set<() => void>();

  readonly getSnapshot = (): PerformancePolicy => this.policy;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<PerformanceSignals>): void {
    this.signals = { ...this.signals, ...patch };
    const next = derivePerformancePolicy(this.signals);
    if (JSON.stringify(next) === JSON.stringify(this.policy)) return;

    this.policy = next;
    this.listeners.forEach((listener) => listener());
  }
}
