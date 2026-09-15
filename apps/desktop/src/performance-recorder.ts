export type ProcessSample = {
  type: "Browser" | "Tab";
  cpu: number;
  workingSetBytes: number;
};

export type ProcessAggregate = {
  cpuPercent: number;
  workingSetBytes: number;
};

export type RiskPerformanceReportV1 = {
  schemaVersion: 1;
  scenario: string;
  buildVersion: string;
  durationMs: number;
  renderer: {
    longTaskCount: number;
    longTaskDurationMs: number;
    heapUsedBytes?: number;
  };
  processes: ProcessAggregate[];
  counters: Record<string, number>;
};

type AppMetric = {
  type: string;
  cpu?: { percentCPUUsage?: number };
  memory?: { workingSetSize?: number };
};

type RendererSnapshot = RiskPerformanceReportV1["renderer"];

export type PerformanceRecorderOptions = {
  reportFile: string;
  scenario: string;
  buildVersion: string;
  durationMs: number;
  now: () => number;
  getAppMetrics: () => readonly AppMetric[];
  requestRendererSnapshot: () => Promise<RendererSnapshot>;
  writeFile: (path: string, contents: string) => Promise<void>;
  setInterval?: (callback: () => void, delayMs: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

export function aggregateProcessSamples(samples: readonly ProcessSample[]): ProcessAggregate {
  return samples.reduce<ProcessAggregate>((aggregate, sample) => ({
    cpuPercent: aggregate.cpuPercent + sample.cpu,
    workingSetBytes: aggregate.workingSetBytes + sample.workingSetBytes,
  }), { cpuPercent: 0, workingSetBytes: 0 });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRendererSnapshot(value: unknown): value is RendererSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return isFiniteNumber(snapshot.longTaskCount)
    && isFiniteNumber(snapshot.longTaskDurationMs)
    && (snapshot.heapUsedBytes === undefined || isFiniteNumber(snapshot.heapUsedBytes));
}

function isProcessAggregate(value: unknown): value is ProcessAggregate {
  if (!value || typeof value !== "object") return false;
  const metric = value as Record<string, unknown>;
  return isFiniteNumber(metric.cpuPercent) && isFiniteNumber(metric.workingSetBytes);
}

export function isRiskPerformanceReportV1(value: unknown): value is RiskPerformanceReportV1 {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  if (report.schemaVersion !== 1
    || typeof report.scenario !== "string"
    || typeof report.buildVersion !== "string"
    || !isFiniteNumber(report.durationMs)
    || !isRendererSnapshot(report.renderer)
    || !Array.isArray(report.processes)
    || !report.processes.every(isProcessAggregate)
    || !report.counters
    || typeof report.counters !== "object") return false;
  return Object.values(report.counters as Record<string, unknown>).every(isFiniteNumber);
}

function toProcessSample(metric: AppMetric): ProcessSample | null {
  if (metric.type !== "Browser" && metric.type !== "Tab") return null;
  const cpu = metric.cpu?.percentCPUUsage;
  const workingSetKiB = metric.memory?.workingSetSize;
  if (!isFiniteNumber(cpu) || !isFiniteNumber(workingSetKiB)) return null;
  return { type: metric.type, cpu, workingSetBytes: workingSetKiB * 1024 };
}

export class PerformanceRecorder {
  private readonly processSamples: ProcessAggregate[] = [];
  private finished: Promise<RiskPerformanceReportV1> | undefined;
  private samplingTimer: unknown;
  private finishTimer: unknown;

  constructor(private readonly options: PerformanceRecorderOptions) {}

  sample(): void {
    const samples = this.options.getAppMetrics()
      .map(toProcessSample)
      .filter((sample): sample is ProcessSample => sample !== null);
    this.processSamples.push(aggregateProcessSamples(samples));
  }

  start(): void {
    if (this.samplingTimer || this.finished) return;
    const setSamplingInterval = this.options.setInterval ?? setInterval;
    const setFinishTimeout = this.options.setTimeout ?? setTimeout;
    this.samplingTimer = setSamplingInterval(() => this.sample(), 1_000);
    this.finishTimer = setFinishTimeout(() => { void this.finish(); }, this.options.durationMs);
  }

  finish(): Promise<RiskPerformanceReportV1> {
    if (!this.finished) this.finished = this.writeReport();
    return this.finished;
  }

  private async writeReport(): Promise<RiskPerformanceReportV1> {
    if (this.samplingTimer) {
      if (this.options.clearInterval) this.options.clearInterval(this.samplingTimer);
      else clearInterval(this.samplingTimer as ReturnType<typeof setInterval>);
    }
    if (this.finishTimer) {
      if (this.options.clearTimeout) this.options.clearTimeout(this.finishTimer);
      else clearTimeout(this.finishTimer as ReturnType<typeof setTimeout>);
    }
    this.samplingTimer = undefined;
    this.finishTimer = undefined;
    let renderer: RendererSnapshot = { longTaskCount: 0, longTaskDurationMs: 0 };
    let rendererSnapshotUnavailable = 0;
    try {
      const received = await this.options.requestRendererSnapshot();
      if (isRendererSnapshot(received)) renderer = received;
      else rendererSnapshotUnavailable = 1;
    } catch {
      rendererSnapshotUnavailable = 1;
    }
    const report: RiskPerformanceReportV1 = {
      schemaVersion: 1,
      scenario: this.options.scenario,
      buildVersion: this.options.buildVersion,
      durationMs: this.options.durationMs,
      renderer,
      processes: this.processSamples,
      counters: {
        processSampleCount: this.processSamples.length,
        ...(rendererSnapshotUnavailable === 1 ? { rendererSnapshotUnavailable } : {}),
      },
    };
    await this.options.writeFile(this.options.reportFile, JSON.stringify(report, null, 2));
    return report;
  }
}
