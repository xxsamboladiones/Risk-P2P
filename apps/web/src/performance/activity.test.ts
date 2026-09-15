import { describe, expect, it, vi } from "vitest";
import { RuntimeActivityTracker } from "./activity";

describe("RuntimeActivityTracker", () => {
  it("keeps transfer activity true until every transfer releases", () => {
    const tracker = new RuntimeActivityTracker();
    const releaseA = tracker.acquire("transferActive", "a");
    const releaseB = tracker.acquire("transferActive", "b");

    releaseA();
    expect(tracker.getSnapshot().transferActive).toBe(true);

    releaseB();
    expect(tracker.getSnapshot().transferActive).toBe(false);
  });

  it("does not notify for overlapping work that leaves an activity active", () => {
    const tracker = new RuntimeActivityTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);

    const releaseA = tracker.acquire("transferActive", "a");
    const releaseB = tracker.acquire("transferActive", "b");
    releaseA();

    expect(listener).toHaveBeenCalledTimes(1);

    releaseB();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("makes releases idempotent and preserves the snapshot when activity stays unchanged", () => {
    const tracker = new RuntimeActivityTracker();
    const release = tracker.acquire("callActive", "call-1");
    const activeSnapshot = tracker.getSnapshot();

    release();
    const inactiveSnapshot = tracker.getSnapshot();
    release();

    expect(tracker.getSnapshot()).toBe(inactiveSnapshot);
    expect(inactiveSnapshot).not.toBe(activeSnapshot);
    expect(tracker.getSnapshot().callActive).toBe(false);
  });
});
