import { readFile } from "node:fs/promises";

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateReport(value, source) {
  if (!value || typeof value !== "object") throw new Error(`${source}: expected a JSON object.`);
  if (value.schemaVersion !== 1) throw new Error(`${source}: expected schemaVersion 1.`);
  if (typeof value.scenario !== "string" || value.scenario.length === 0) throw new Error(`${source}: scenario must be a non-empty string.`);
  if (typeof value.buildVersion !== "string" || value.buildVersion.length === 0) throw new Error(`${source}: buildVersion must be a non-empty string.`);
  if (!isNumber(value.durationMs) || value.durationMs === 0) throw new Error(`${source}: durationMs must be a positive number.`);
  const renderer = value.renderer;
  if (!renderer || !isNumber(renderer.longTaskCount) || !isNumber(renderer.longTaskDurationMs)
    || (renderer.heapUsedBytes !== undefined && !isNumber(renderer.heapUsedBytes))) {
    throw new Error(`${source}: renderer metrics are invalid.`);
  }
  if (!Array.isArray(value.processes) || !value.processes.every((sample) => (
    sample && isNumber(sample.cpuPercent) && isNumber(sample.workingSetBytes)
  ))) throw new Error(`${source}: process metrics are invalid.`);
  if (!value.counters || typeof value.counters !== "object"
    || !Object.values(value.counters).every(isNumber)) throw new Error(`${source}: counters are invalid.`);
  return value;
}

async function readReport(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReport(parsed, file);
}

function mean(samples, key) {
  if (samples.length === 0) return 0;
  return samples.reduce((total, sample) => total + sample[key], 0) / samples.length;
}

function formatBytes(value) {
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function summary(report) {
  return {
    scenario: report.scenario,
    build: report.buildVersion,
    duration: `${(report.durationMs / 1000).toFixed(0)} s`,
    samples: report.processes.length,
    avgCpu: `${mean(report.processes, "cpuPercent").toFixed(2)}%`,
    avgWorkingSet: formatBytes(mean(report.processes, "workingSetBytes")),
    longTasks: report.renderer.longTaskCount,
    longTaskDuration: `${report.renderer.longTaskDurationMs.toFixed(0)} ms`,
  };
}

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile || process.argv.length !== 4) {
  console.error("Usage: pnpm performance:report -- before.json after.json");
  process.exitCode = 1;
} else {
  try {
    const [before, after] = await Promise.all([readReport(beforeFile), readReport(afterFile)]);
    if (before.scenario !== after.scenario) throw new Error("Reports use different scenarios and are not comparable.");
    if (before.durationMs !== after.durationMs) throw new Error("Reports use different durations and are not comparable.");
    console.table([summary(before), summary(after)]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
