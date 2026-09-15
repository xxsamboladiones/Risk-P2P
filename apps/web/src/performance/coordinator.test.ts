import { describe, expect, it, vi } from "vitest";
import { PerformanceCoordinator } from "./coordinator";

describe("PerformanceCoordinator", () => {
  it("notifies only when effective policy changes", () => {
    const coordinator = new PerformanceCoordinator();
    const listener = vi.fn();
    coordinator.subscribe(listener);

    coordinator.update({ documentVisible: true });
    expect(listener).not.toHaveBeenCalled();

    coordinator.update({ documentVisible: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the current snapshot stable when an update leaves the policy unchanged", () => {
    const coordinator = new PerformanceCoordinator();
    const snapshot = coordinator.getSnapshot();

    coordinator.update({ documentVisible: true });

    expect(coordinator.getSnapshot()).toBe(snapshot);
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const coordinator = new PerformanceCoordinator();
    const listener = vi.fn();
    const unsubscribe = coordinator.subscribe(listener);
    unsubscribe();

    coordinator.update({ documentVisible: false });

    expect(listener).not.toHaveBeenCalled();
  });
});
