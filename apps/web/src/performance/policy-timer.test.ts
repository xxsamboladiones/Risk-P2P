import { afterEach, expect, it, vi } from "vitest";
import { PolicyTimer } from "./policy-timer";

afterEach(() => {
  vi.useRealTimers();
});

it("does not tick while cadence is null and resumes with one timer", async () => {
  vi.useFakeTimers();
  const callback = vi.fn();
  const timer = new PolicyTimer(callback);

  timer.setCadence(null);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(callback).not.toHaveBeenCalled();

  timer.setCadence(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(callback).toHaveBeenCalledOnce();
});

it("replaces the pending timer when cadence changes", async () => {
  vi.useFakeTimers();
  const callback = vi.fn();
  const timer = new PolicyTimer(callback);

  timer.setCadence(1_000);
  await vi.advanceTimersByTimeAsync(500);
  timer.setCadence(2_000);

  await vi.advanceTimersByTimeAsync(500);
  expect(callback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(callback).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(callback).toHaveBeenCalledTimes(2);
});
