import type { RuntimeActivity } from "./policy";

type ActivityKind = keyof RuntimeActivity;

export class RuntimeActivityTracker {
  private readonly keyCounts: Record<ActivityKind, Map<string, number>> = {
    callActive: new Map(),
    transferActive: new Map(),
    screenPublicationActive: new Map(),
    gameSessionActive: new Map(),
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
    const keyCounts = this.keyCounts[kind];
    const wasEmpty = keyCounts.size === 0;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    if (wasEmpty) this.setActive(kind, true);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remainingLeases = (keyCounts.get(key) ?? 1) - 1;
      if (remainingLeases > 0) {
        keyCounts.set(key, remainingLeases);
        return;
      }

      keyCounts.delete(key);
      if (keyCounts.size > 0) return;
      this.setActive(kind, false);
    };
  }

  private setActive(kind: ActivityKind, active: boolean): void {
    if (this.snapshot[kind] === active) return;
    this.snapshot = { ...this.snapshot, [kind]: active };
    this.listeners.forEach((listener) => listener());
  }
}
