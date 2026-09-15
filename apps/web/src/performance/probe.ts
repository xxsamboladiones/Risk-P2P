export type RendererPerformanceSnapshot = {
  longTaskCount: number;
  longTaskDurationMs: number;
  heapUsedBytes?: number;
};

export type RendererPerformanceProbeOptions = {
  now?: () => number;
};

export type RendererPerformanceBridge = {
  onStartCapture: (callback: () => void) => () => void;
  onRequestSnapshot: (callback: () => void) => () => void;
  reportSnapshot: (snapshot: RendererPerformanceSnapshot) => Promise<void>;
};

export class RendererPerformanceProbe {
  private longTaskCount = 0;
  private longTaskDurationMs = 0;
  private observer: PerformanceObserver | undefined;

  constructor(_options: RendererPerformanceProbeOptions = {}) {}

  observeLongTask(durationMs: number): void {
    this.longTaskCount += 1;
    this.longTaskDurationMs += durationMs;
  }

  startCapture(): void {
    this.longTaskCount = 0;
    this.longTaskDurationMs = 0;
  }

  startLongTaskObserver(): () => void {
    if (typeof PerformanceObserver === "undefined") return () => undefined;
    this.observer?.disconnect();
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.observeLongTask(entry.duration);
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer = undefined;
    }
    return () => {
      this.observer?.disconnect();
      this.observer = undefined;
    };
  }

  snapshot(): RendererPerformanceSnapshot {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const heapUsedBytes = memory?.usedJSHeapSize;
    return {
      longTaskCount: this.longTaskCount,
      longTaskDurationMs: this.longTaskDurationMs,
      ...(typeof heapUsedBytes === "number" && Number.isFinite(heapUsedBytes) ? { heapUsedBytes } : {}),
    };
  }
}

export function installRendererPerformanceProbe(bridge: RendererPerformanceBridge): () => void {
  const probe = new RendererPerformanceProbe();
  const stopObserving = probe.startLongTaskObserver();
  const stopCaptureStarts = bridge.onStartCapture(() => probe.startCapture());
  const stopRequests = bridge.onRequestSnapshot(() => {
    void bridge.reportSnapshot(probe.snapshot());
  });
  return () => {
    stopRequests();
    stopCaptureStarts();
    stopObserving();
  };
}
