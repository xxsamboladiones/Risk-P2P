import type { RuntimeActivity } from "./policy";

type ActivityKind = keyof RuntimeActivity;

export class RuntimeActivityTracker {
  private readonly keys: Record<ActivityKind, Set<string>> = {
    callActive: new Set(),
    transferActive: new Set(),
    screenPublicationActive: new Set(),
    gameSessionActive: new Set(),
  };

  private snapshot: RuntimeActivity = {
    callActive: false,
    transferActive: false,
    screenPublicationActive: false,
    gameSessionActive: false,
  };

  private listeners = new Set<() => void>();

  readonly getSnapshot = (): RuntimeActivity => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  acquire(kind: ActivityKind, key: string): () => void {
    const activityKeys = this.keys[kind];
    const wasEmpty = activityKeys.size === 0;
    activityKeys.add(key);
    if (wasEmpty && activityKeys.size > 0) this.setActive(kind, true);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!activityKeys.delete(key) || activityKeys.size > 0) return;
      this.setActive(kind, false);
    };
  }

  private setActive(kind: ActivityKind, active: boolean): void {
    if (this.snapshot[kind] === active) return;
    this.snapshot = { ...this.snapshot, [kind]: active };
    this.listeners.forEach((listener) => listener());
  }
}
