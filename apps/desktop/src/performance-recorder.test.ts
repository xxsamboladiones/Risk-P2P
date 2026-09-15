import { describe, expect, it } from "vitest";
import {
  aggregateProcessSamples,
  isRiskPerformanceReportV1,
  PerformanceRecorder,
} from "./performance-recorder.js";

describe("aggregateProcessSamples", () => {
  it("aggregates only Risk process metrics", () => {
    expect(aggregateProcessSamples([
      { type: "Browser", cpu: 4, workingSetBytes: 100 },
      { type: "Tab", cpu: 7, workingSetBytes: 200 },
    ])).toEqual({ cpuPercent: 11, workingSetBytes: 300 });
  });
});

describe("PerformanceRecorder", () => {
  it("writes a versioned report with one renderer snapshot", async () => {
    let captured: string | undefined;
    const recorder = new PerformanceRecorder({
      reportFile: "C:/reports/home-idle.json",
      scenario: "foreground-idle-home",
      buildVersion: "0.2.1",
      durationMs: 60_000,
      now: () => 1_000,
      getAppMetrics: () => [{
        type: "Browser",
        cpu: { percentCPUUsage: 4 },
        memory: { workingSetSize: 100 },
      }],
      requestRendererSnapshot: async () => ({
        longTaskCount: 2,
        longTaskDurationMs: 123,
        heapUsedBytes: 456,
      }),
      writeFile: async (_path, contents) => { captured = contents; },
    });

    recorder.sample();
    await recorder.finish();

    expect(JSON.parse(captured!)).toEqual({
      schemaVersion: 1,
      scenario: "foreground-idle-home",
      buildVersion: "0.2.1",
      durationMs: 60_000,
      renderer: { longTaskCount: 2, longTaskDurationMs: 123, heapUsedBytes: 456 },
      processes: [{ cpuPercent: 4, workingSetBytes: 102_400 }],
      counters: { processSampleCount: 1 },
    });
  });

  it("rejects a report whose process metric is not numeric", () => {
    expect(isRiskPerformanceReportV1({
      schemaVersion: 1,
      scenario: "foreground-idle-home",
      buildVersion: "0.2.1",
      durationMs: 60_000,
      renderer: { longTaskCount: 0, longTaskDurationMs: 0 },
      processes: [{ cpuPercent: "four", workingSetBytes: 102_400 }],
      counters: { processSampleCount: 1 },
    })).toBe(false);
  });

  it("samples once per scheduled second while a capture is active", async () => {
    let tick: (() => void) | undefined;
    let captured: string | undefined;
    const recorder = new PerformanceRecorder({
      reportFile: "C:/reports/home-idle.json",
      scenario: "foreground-idle-home",
      buildVersion: "0.2.1",
      durationMs: 60_000,
      now: () => 1_000,
      getAppMetrics: () => [{
        type: "Tab",
        cpu: { percentCPUUsage: 7 },
        memory: { workingSetSize: 200 },
      }],
      requestRendererSnapshot: async () => ({ longTaskCount: 0, longTaskDurationMs: 0 }),
      writeFile: async (_path, contents) => { captured = contents; },
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => undefined,
      setTimeout: () => 2,
      clearTimeout: () => undefined,
    });

    recorder.start();
    tick!();
    await recorder.finish();

    expect(JSON.parse(captured!).processes).toEqual([{ cpuPercent: 7, workingSetBytes: 204_800 }]);
  });
});
