import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererPerformanceProbe, RendererPerformanceProbe } from "./probe";

describe("RendererPerformanceProbe", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records long-task count and total duration", () => {
    const probe = new RendererPerformanceProbe({ now: () => 100 });

    probe.observeLongTask(72);
    probe.observeLongTask(51);

    expect(probe.snapshot()).toMatchObject({ longTaskCount: 2, longTaskDurationMs: 123 });
  });

  it("collects browser long-task entries through a PerformanceObserver", () => {
    let notify: ((entries: PerformanceEntryList) => void) | undefined;
    vi.stubGlobal("PerformanceObserver", class {
      constructor(callback: PerformanceObserverCallback) {
        notify = (entries) => callback({ getEntries: () => entries } as unknown as PerformanceObserverEntryList, this as PerformanceObserver);
      }

      observe(): void {}
      disconnect(): void {}
      takeRecords(): PerformanceEntryList { return []; }
    });
    const probe = new RendererPerformanceProbe();

    probe.startLongTaskObserver();
    notify!([{ duration: 64 } as PerformanceEntry]);

    expect(probe.snapshot()).toMatchObject({ longTaskCount: 1, longTaskDurationMs: 64 });
  });

  it("returns the accumulated renderer snapshot when the desktop recorder requests it", async () => {
    let requested: (() => void) | undefined;
    let started: (() => void) | undefined;
    const received: unknown[] = [];
    const stop = installRendererPerformanceProbe({
      onStartCapture: (callback) => {
        started = callback;
        return () => undefined;
      },
      onRequestSnapshot: (callback) => {
        requested = callback;
        return () => undefined;
      },
      reportSnapshot: async (snapshot) => { received.push(snapshot); },
    });

    requested!();
    await Promise.resolve();

    expect(received).toEqual([{ longTaskCount: 0, longTaskDurationMs: 0 }]);
    stop();
  });

  it("resets preparation measurements when a capture starts", async () => {
    let notify: ((entries: PerformanceEntryList) => void) | undefined;
    let started: (() => void) | undefined;
    let requested: (() => void) | undefined;
    const received: unknown[] = [];
    vi.stubGlobal("PerformanceObserver", class {
      constructor(callback: PerformanceObserverCallback) {
        notify = (entries) => callback({ getEntries: () => entries } as unknown as PerformanceObserverEntryList, this as PerformanceObserver);
      }

      observe(): void {}
      disconnect(): void {}
      takeRecords(): PerformanceEntryList { return []; }
    });
    const stop = installRendererPerformanceProbe({
      onStartCapture: (callback) => {
        started = callback;
        return () => undefined;
      },
      onRequestSnapshot: (callback) => {
        requested = callback;
        return () => undefined;
      },
      reportSnapshot: async (snapshot) => { received.push(snapshot); },
    });

    notify!([{ duration: 72 } as PerformanceEntry]);
    started!();
    notify!([{ duration: 51 } as PerformanceEntry]);
    requested!();
    await Promise.resolve();

    expect(received).toEqual([{ longTaskCount: 1, longTaskDurationMs: 51 }]);
    stop();
  });
});
