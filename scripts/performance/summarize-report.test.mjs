import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./summarize-report.mjs", import.meta.url));

function runSummary(before, after) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, before, after]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

test("rejects an empty process sample report instead of summarizing it as zero activity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "risk-performance-"));
  const valid = {
    schemaVersion: 1,
    scenario: "foreground-idle-home",
    buildVersion: "0.2.1",
    durationMs: 60_000,
    renderer: { longTaskCount: 0, longTaskDurationMs: 0 },
    processes: [{ cpuPercent: 4, workingSetBytes: 102_400 }],
    counters: { processSampleCount: 1 },
  };
  const incomplete = { ...valid, processes: [], counters: { processSampleCount: 0 } };
  const before = path.join(directory, "before.json");
  const after = path.join(directory, "after.json");
  await Promise.all([
    writeFile(before, JSON.stringify(valid)),
    writeFile(after, JSON.stringify(incomplete)),
  ]);

  const result = await runSummary(before, after);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /process metrics are invalid/);
});

test("rejects a zero working-set process sample instead of summarizing an incomplete capture", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "risk-performance-"));
  const valid = {
    schemaVersion: 1,
    scenario: "foreground-idle-home",
    buildVersion: "0.2.1",
    durationMs: 60_000,
    renderer: { longTaskCount: 0, longTaskDurationMs: 0 },
    processes: [{ cpuPercent: 4, workingSetBytes: 102_400 }],
    counters: { processSampleCount: 1 },
  };
  const incomplete = { ...valid, processes: [{ cpuPercent: 0, workingSetBytes: 0 }] };
  const before = path.join(directory, "before.json");
  const after = path.join(directory, "after.json");
  await Promise.all([
    writeFile(before, JSON.stringify(valid)),
    writeFile(after, JSON.stringify(incomplete)),
  ]);

  const result = await runSummary(before, after);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /process metrics are invalid/);
});
