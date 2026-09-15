# Performance PR 1: Measurement and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish attributable Windows performance measurements and a pure lifecycle policy that safely throttles hidden idle work without disrupting calls, publications, games, transfers, presence, or notifications.

**Architecture:** A renderer-owned `PerformanceCoordinator` converts document visibility, call presentation, runtime activity, and media pressure into an immutable `PerformancePolicy`. Electron and feature adapters subscribe to the policy and execute only their own behavior; the coordinator never calls controllers, tracks, Mesh, React state, or windows.

**Tech Stack:** TypeScript 5.7, React 19, Zustand 5, Electron 43, Vitest 3, Node.js scripts, Web Performance APIs.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-windows-performance-design.md`

## Global Constraints

- Primary platform is Windows 10 and newer; Windows 7 and 8.1 are not supported.
- Preserve every existing feature, security boundary, messaging guarantee, and normal visible visual/media quality.
- Hardware acceleration stays enabled by default; GPU fallback is deferred to PR 4 and requires observed failure.
- Screen adaptation must never go below 854x480 at 30 FPS; PR 1 records `MediaPressure` but does not adapt media.
- `ExecutionMode`, `RuntimeActivity`, and `MediaPressure` remain independent inputs.
- The coordinator decides policy; adapters execute it.
- Preserve all pre-existing uncommitted work and stage only files named by the current task.
- Do not claim CPU or memory improvement without same-machine, same-build, same-duration measurements.

---

## File Structure

- `apps/web/src/performance/policy.ts`: pure types and lifecycle-policy derivation.
- `apps/web/src/performance/coordinator.ts`: observable signal store; no feature imports.
- `apps/web/src/performance/activity.ts`: ref-counted critical activity registry.
- `apps/web/src/performance/PerformanceRuntimeBridge.tsx`: React/document adapter.
- `apps/web/src/performance/probe.ts`: renderer long-task and heap measurement.
- `apps/desktop/src/performance-recorder.ts`: own-process sampling and JSON report writer.
- `apps/desktop/src/performance-policy.ts`: validates and applies the renderer's Electron-facing permission.
- `scripts/performance/summarize-report.mjs`: deterministic report validation and comparison.

### Task 1: Reproducible Windows measurement harness and baseline

**Files:**
- Create: `apps/web/src/performance/probe.ts`
- Create: `apps/web/src/performance/probe.test.ts`
- Create: `apps/desktop/src/performance-recorder.ts`
- Create: `apps/desktop/src/performance-recorder.test.ts`
- Create: `scripts/performance/summarize-report.mjs`
- Create: `docs/performance/windows-scenarios.md`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/window.ts`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: browser `PerformanceObserver`, Electron `app.getAppMetrics()`, `RISK_PERFORMANCE_REPORT_FILE`, and `RISK_PERFORMANCE_DURATION_MS`.
- Produces: versioned `RiskPerformanceReportV1` JSON and `pnpm performance:report -- before.json after.json`.

- [ ] **Step 1: Write failing aggregation and schema tests**

```typescript
it("aggregates only Risk process metrics", () => {
  expect(aggregateProcessSamples([{ type: "Browser", cpu: 4, workingSetBytes: 100 }, { type: "Tab", cpu: 7, workingSetBytes: 200 }]))
    .toEqual({ cpuPercent: 11, workingSetBytes: 300 });
});

it("records long-task count and total duration", () => {
  const probe = new RendererPerformanceProbe({ now: () => 100 });
  probe.observeLongTask(72);
  probe.observeLongTask(51);
  expect(probe.snapshot()).toMatchObject({ longTaskCount: 2, longTaskDurationMs: 123 });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @risk/web test -- src/performance/probe.test.ts`

Expected: FAIL because `RendererPerformanceProbe` is missing.

Run: `pnpm --filter @risk/desktop test -- src/performance-recorder.test.ts`

Expected: FAIL because the recorder is missing.

- [ ] **Step 3: Implement opt-in measurement without production hot-path work**

```typescript
export type RiskPerformanceReportV1 = {
  schemaVersion: 1;
  scenario: string;
  buildVersion: string;
  durationMs: number;
  renderer: { longTaskCount: number; longTaskDurationMs: number; heapUsedBytes?: number };
  processes: { cpuPercent: number; workingSetBytes: number }[];
  counters: Record<string, number>;
};
```

Create observers only when `RISK_PERFORMANCE_REPORT_FILE` is set. In that mode, register `CommandOrControl+Alt+Shift+F11` to start a named 60-second sample after the scenario is prepared. Sample `app.getAppMetrics()` once per second, request one renderer snapshot over validated IPC, and write JSON only from the main process to the environment-provided path. Add the new desktop files to the Electron builder list.

- [ ] **Step 4: Capture the unchanged-behavior baseline**

Document fixed 60-second preparation for all nine spec scenarios, release build, power plan, display resolution, participant count, and screen source. Build the desktop package, capture reports into `performance-results/pr1-baseline/`, and validate them with `scripts/performance/summarize-report.mjs`. Commit source/docs only; performance result JSON remains a local artifact unless the user explicitly requests it in version control.

Run: `pnpm build:desktop`

Expected: exit 0 and reports contain CPU, working set, long tasks, and counters without claiming improvement.

- [ ] **Step 5: Commit the harness before behavior changes**

```bash
git add apps/web/src/performance/probe.ts apps/web/src/performance/probe.test.ts apps/desktop/src/performance-recorder.ts apps/desktop/src/performance-recorder.test.ts scripts/performance/summarize-report.mjs docs/performance/windows-scenarios.md apps/desktop/src/main.ts apps/desktop/src/window.ts apps/desktop/package.json package.json
git commit -m "test(performance): add attributable Windows benchmarks"
```

### Task 2: Pure execution policy

**Files:**
- Create: `apps/web/src/performance/policy.ts`
- Create: `apps/web/src/performance/policy.test.ts`

**Interfaces:**
- Consumes: no application modules.
- Produces: `ExecutionMode`, `MediaPressure`, `RuntimeActivity`, `PerformanceSignals`, `PerformancePolicy`, `derivePerformancePolicy(signals)`.

- [ ] **Step 1: Write the failing lifecycle matrix test**

```typescript
import { describe, expect, it } from "vitest";
import { derivePerformancePolicy, type PerformanceSignals } from "./policy";

const base: PerformanceSignals = {
  documentVisible: true,
  callWorkspaceVisible: false,
  mediaPressure: "normal",
  activity: { callActive: false, transferActive: false, screenPublicationActive: false, gameSessionActive: false },
};

describe("performance policy", () => {
  it.each([
    [{}, "foreground"],
    [{ callWorkspaceVisible: true, activity: { ...base.activity, callActive: true } }, "foreground-call"],
    [{ documentVisible: false, activity: { ...base.activity, callActive: true } }, "background-call"],
    [{ documentVisible: false }, "idle-hidden"],
  ] as const)("derives the execution mode for %j", (patch, mode) => {
    expect(derivePerformancePolicy({ ...base, ...patch }).mode).toBe(mode);
  });

  it("keeps a hidden transfer schedulable without inventing a new mode", () => {
    const policy = derivePerformancePolicy({
      ...base,
      documentVisible: false,
      activity: { ...base.activity, transferActive: true },
    });
    expect(policy.mode).toBe("idle-hidden");
    expect(policy.hasCriticalBackgroundWork).toBe(true);
    expect(policy.chromiumBackgroundThrottlingAllowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @risk/web test -- src/performance/policy.test.ts`

Expected: FAIL because `./policy` does not exist.

- [ ] **Step 3: Implement the minimal pure policy**

```typescript
export type ExecutionMode = "foreground" | "foreground-call" | "background-call" | "idle-hidden";
export type MediaPressure = "normal" | "warning" | "overloaded";
export type RuntimeActivity = { callActive: boolean; transferActive: boolean; screenPublicationActive: boolean; gameSessionActive: boolean };
export type PerformanceSignals = { documentVisible: boolean; callWorkspaceVisible: boolean; mediaPressure: MediaPressure; activity: RuntimeActivity };
export type PerformancePolicy = {
  mode: ExecutionMode;
  mediaPressure: MediaPressure;
  hasCriticalBackgroundWork: boolean;
  visualVoiceActivityEnabled: boolean;
  hiddenVideoPresentationEnabled: boolean;
  diagnosticsIntervalMs: number | null;
  chromiumBackgroundThrottlingAllowed: boolean;
};

export function derivePerformancePolicy(signals: PerformanceSignals): PerformancePolicy {
  const hasCriticalBackgroundWork = Object.values(signals.activity).some(Boolean);
  const mode: ExecutionMode = signals.documentVisible && signals.callWorkspaceVisible
    ? "foreground-call"
    : signals.activity.callActive
      ? "background-call"
      : signals.documentVisible ? "foreground" : "idle-hidden";
  return {
    mode,
    mediaPressure: signals.mediaPressure,
    hasCriticalBackgroundWork,
    visualVoiceActivityEnabled: mode === "foreground-call",
    hiddenVideoPresentationEnabled: mode === "foreground-call",
    diagnosticsIntervalMs: mode === "foreground-call" ? 3_000 : mode === "background-call" ? 10_000 : null,
    chromiumBackgroundThrottlingAllowed: !hasCriticalBackgroundWork,
  };
}
```

- [ ] **Step 4: Run the focused test and full web typecheck**

Run: `pnpm --filter @risk/web test -- src/performance/policy.test.ts`

Expected: PASS.

Run: `pnpm --filter @risk/web typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the isolated policy**

```bash
git add apps/web/src/performance/policy.ts apps/web/src/performance/policy.test.ts
git commit -m "feat(performance): define pure runtime policy"
```

### Task 3: Observable coordinator and activity registry

**Files:**
- Create: `apps/web/src/performance/coordinator.ts`
- Create: `apps/web/src/performance/coordinator.test.ts`
- Create: `apps/web/src/performance/activity.ts`
- Create: `apps/web/src/performance/activity.test.ts`

**Interfaces:**
- Consumes: `PerformanceSignals`, `PerformancePolicy`, `derivePerformancePolicy` from Task 2.
- Produces: `PerformanceCoordinator.getSnapshot()`, `.subscribe(listener)`, `.update(patch)` and `RuntimeActivityTracker.acquire(kind, key)`.

- [ ] **Step 1: Write failing tests for deduplicated notifications and ref-counted work**

```typescript
it("notifies only when effective policy changes", () => {
  const coordinator = new PerformanceCoordinator();
  const listener = vi.fn();
  coordinator.subscribe(listener);
  coordinator.update({ documentVisible: true });
  expect(listener).not.toHaveBeenCalled();
  coordinator.update({ documentVisible: false });
  expect(listener).toHaveBeenCalledTimes(1);
});

it("keeps transfer activity true until every transfer releases", () => {
  const tracker = new RuntimeActivityTracker();
  const releaseA = tracker.acquire("transferActive", "a");
  const releaseB = tracker.acquire("transferActive", "b");
  releaseA();
  expect(tracker.getSnapshot().transferActive).toBe(true);
  releaseB();
  expect(tracker.getSnapshot().transferActive).toBe(false);
});
```

- [ ] **Step 2: Run both tests and verify RED**

Run: `pnpm --filter @risk/web test -- src/performance/coordinator.test.ts src/performance/activity.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement stable external stores**

```typescript
export class PerformanceCoordinator {
  private signals: PerformanceSignals = {
    documentVisible: true,
    callWorkspaceVisible: false,
    mediaPressure: "normal",
    activity: { callActive: false, transferActive: false, screenPublicationActive: false, gameSessionActive: false },
  };
  private policy = derivePerformancePolicy(this.signals);
  private listeners = new Set<() => void>();
  readonly getSnapshot = (): PerformancePolicy => this.policy;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  update(patch: Partial<PerformanceSignals>): void {
    this.signals = { ...this.signals, ...patch };
    const next = derivePerformancePolicy(this.signals);
    if (JSON.stringify(next) === JSON.stringify(this.policy)) return;
    this.policy = next;
    this.listeners.forEach((listener) => listener());
  }
}
```

Implement `RuntimeActivityTracker` with one `Set<string>` per `keyof RuntimeActivity`, an idempotent release closure, a stable snapshot, and listener notification only when a boolean changes.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @risk/web test -- src/performance/coordinator.test.ts src/performance/activity.test.ts`

Expected: PASS with one notification for each boolean transition.

Run: `pnpm --filter @risk/web typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the stores**

```bash
git add apps/web/src/performance/coordinator.ts apps/web/src/performance/coordinator.test.ts apps/web/src/performance/activity.ts apps/web/src/performance/activity.test.ts
git commit -m "feat(performance): add coordinator and activity registry"
```

### Task 4: Application composition and lifecycle bridge

**Files:**
- Modify: `apps/web/src/application/RiskApplication.ts`
- Modify: `apps/web/src/application/runtime.ts`
- Create: `apps/web/src/performance/PerformanceRuntimeBridge.tsx`
- Create: `apps/web/src/performance/PerformanceRuntimeBridge.test.ts`
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: `PerformanceCoordinator` and `RuntimeActivityTracker` from Task 3; existing Zustand call store and `GameModeController.subscribe`.
- Produces: `RiskApplication.performance`, `RiskApplication.performanceActivity`, `usePerformancePolicy()`.

- [ ] **Step 1: Write a failing pure bridge-input test**

```typescript
import { performanceSignalsFromUi } from "./PerformanceRuntimeBridge";

it("separates call presentation from critical activity", () => {
  expect(performanceSignalsFromUi({
    documentVisible: false,
    callWorkspaceOpen: false,
    roomId: "room",
    screenShare: true,
    gameSessionActive: false,
    trackedActivity: { callActive: false, transferActive: true, screenPublicationActive: false, gameSessionActive: false },
  })).toMatchObject({
    documentVisible: false,
    callWorkspaceVisible: false,
    activity: { callActive: true, transferActive: true, screenPublicationActive: true, gameSessionActive: false },
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @risk/web test -- src/performance/PerformanceRuntimeBridge.test.ts`

Expected: FAIL because the bridge module is absent.

- [ ] **Step 3: Add composition-root ownership and the React adapter**

Add constructor dependencies and readonly fields:

```typescript
performance: PerformanceCoordinator;
performanceActivity: RuntimeActivityTracker;
```

Create both once in `createRiskApplication()`. `PerformanceRuntimeBridge` uses `useSyncExternalStore` for the call store, game snapshot, activity tracker, and coordinator. It installs one `visibilitychange` listener, calls `coordinator.update(...)`, and renders `null`. Export:

```typescript
export function usePerformancePolicy(): PerformancePolicy {
  const { performance } = useRiskApplication();
  return useSyncExternalStore(performance.subscribe, performance.getSnapshot);
}
```

Mount `<PerformanceRuntimeBridge/>` inside `RiskApplicationProvider` and outside error-prone feature views.

- [ ] **Step 4: Run focused application tests and typecheck**

Run: `pnpm --filter @risk/web test -- src/performance/PerformanceRuntimeBridge.test.ts src/application/ui-boundary.test.ts`

Expected: PASS; the boundary test still forbids infrastructure imports from views.

Run: `pnpm --filter @risk/web typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the bridge**

```bash
git add apps/web/src/application/RiskApplication.ts apps/web/src/application/runtime.ts apps/web/src/performance/PerformanceRuntimeBridge.tsx apps/web/src/performance/PerformanceRuntimeBridge.test.ts apps/web/src/main.tsx
git commit -m "feat(performance): compose lifecycle coordinator"
```

### Task 5: Transfer activity reporting

**Files:**
- Modify: `apps/web/src/chat/AttachmentService.ts`
- Modify: `apps/web/src/chat/ChatController.ts`
- Modify: `apps/web/src/chat/AttachmentService.test.ts`
- Modify: `apps/web/src/application/runtime.ts`

**Interfaces:**
- Consumes: `RuntimeActivityTracker.acquire("transferActive", transferId)`.
- Produces: transfer activity that remains true for states `accepted`, `queued`, `transferring`, and `verifying`, and releases for every terminal/paused state.

- [ ] **Step 1: Write the failing overlapping-transfer test**

```typescript
it("reports critical activity until the final active transfer settles", () => {
  const activity = new RuntimeActivityTracker();
  const service = new ChatAttachmentService(activity);
  service.observeTransferState("a", "transferring");
  service.observeTransferState("b", "verifying");
  service.observeTransferState("a", "completed");
  expect(activity.getSnapshot().transferActive).toBe(true);
  service.observeTransferState("b", "failed");
  expect(activity.getSnapshot().transferActive).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @risk/web test -- src/chat/AttachmentService.test.ts`

Expected: FAIL because the constructor and `observeTransferState` do not exist.

- [ ] **Step 3: Inject the activity registry and release terminal transfers**

```typescript
private readonly transferReleases = new Map<string, () => void>();
observeTransferState(id: string, state: StoredAttachmentRecord["state"]): void {
  const active = ["accepted", "queued", "transferring", "verifying"].includes(state);
  if (active && !this.transferReleases.has(id)) {
    this.transferReleases.set(id, this.activity.acquire("transferActive", id));
  } else if (!active) {
    this.transferReleases.get(id)?.();
    this.transferReleases.delete(id);
  }
}
```

Call this method from both attachment and progress events. Release every remaining entry in `clear()`. Change `ChatController` to accept the tracker and construct `ChatAttachmentService` in its constructor; pass the same tracker from every `createChat` call in `runtime.ts`.

- [ ] **Step 4: Run attachment, chat, and background-manager tests**

Run: `pnpm --filter @risk/web test -- src/chat/AttachmentService.test.ts src/chat-controller.test.ts src/services/chat/background-manager.test.ts`

Expected: PASS; simultaneous background chats share one activity registry.

- [ ] **Step 5: Commit transfer reporting**

```bash
git add apps/web/src/chat/AttachmentService.ts apps/web/src/chat/ChatController.ts apps/web/src/chat/AttachmentService.test.ts apps/web/src/application/runtime.ts
git commit -m "feat(performance): track critical file transfers"
```

### Task 6: Electron background-throttling adapter

**Files:**
- Create: `apps/desktop/src/performance-policy.ts`
- Create: `apps/desktop/src/performance-policy.test.ts`
- Modify: `apps/desktop/src/ipc/index.ts`
- Modify: `apps/desktop/src/preload.cts`
- Modify: `apps/web/src/vite-env.d.ts`
- Modify: `apps/web/src/performance/PerformanceRuntimeBridge.tsx`
- Modify: `apps/desktop/src/window.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: `PerformancePolicy.chromiumBackgroundThrottlingAllowed`.
- Produces: preload method `setPerformancePolicy({ chromiumBackgroundThrottlingAllowed: boolean }): Promise<void>` and validated IPC channel `performance:set-policy`.

- [ ] **Step 1: Write failing validation tests**

```typescript
it("accepts only the Electron-facing boolean permission", () => {
  expect(parseDesktopPerformancePolicy({ chromiumBackgroundThrottlingAllowed: true })).toEqual({ chromiumBackgroundThrottlingAllowed: true });
  expect(() => parseDesktopPerformancePolicy({ chromiumBackgroundThrottlingAllowed: "yes" })).toThrow("Política de desempenho inválida");
  expect(() => parseDesktopPerformancePolicy({ chromiumBackgroundThrottlingAllowed: true, command: "quit" })).toThrow("Política de desempenho inválida");
});
```

- [ ] **Step 2: Run desktop tests and verify RED**

Run: `pnpm --filter @risk/desktop test -- src/performance-policy.test.ts`

Expected: FAIL because the parser is missing.

- [ ] **Step 3: Implement the narrow IPC adapter**

```typescript
export type DesktopPerformancePolicy = { chromiumBackgroundThrottlingAllowed: boolean };
export function parseDesktopPerformancePolicy(value: unknown): DesktopPerformancePolicy {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1
    || typeof (value as DesktopPerformancePolicy).chromiumBackgroundThrottlingAllowed !== "boolean") {
    throw new Error("Política de desempenho inválida.");
  }
  return value as DesktopPerformancePolicy;
}
```

The IPC handler validates renderer origin, resolves `BrowserWindow.fromWebContents(event.sender)`, and calls `owner.webContents.setBackgroundThrottling(policy.chromiumBackgroundThrottlingAllowed)`. Set the initial window preference to `backgroundThrottling: true`. The React bridge sends only when the boolean changes and treats a missing desktop bridge as a no-op.

- [ ] **Step 4: Run desktop/web tests and typechecks**

Run: `pnpm --filter @risk/desktop test -- src/performance-policy.test.ts src/main.test.ts src/desktop-modules.test.ts`

Expected: PASS.

Run: `pnpm --filter @risk/web typecheck`

Expected: exit 0.

Run: `pnpm --filter @risk/desktop typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit dynamic Chromium throttling**

```bash
git add apps/desktop/src/performance-policy.ts apps/desktop/src/performance-policy.test.ts apps/desktop/src/ipc/index.ts apps/desktop/src/preload.cts apps/web/src/vite-env.d.ts apps/web/src/performance/PerformanceRuntimeBridge.tsx apps/desktop/src/window.ts apps/desktop/package.json
git commit -m "feat(performance): apply lifecycle-aware Chromium throttling"
```

### Task 7: Hidden UI cadence and foreground coalescing

**Files:**
- Create: `apps/web/src/performance/policy-timer.ts`
- Create: `apps/web/src/performance/policy-timer.test.ts`
- Modify: `apps/web/src/components/P2PInvitePanel.tsx`
- Modify: `apps/web/src/performance/PerformanceRuntimeBridge.tsx`
- Modify: `apps/web/src/services/chat/background-manager.ts`
- Modify: `apps/web/src/services/chat/background-manager.test.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `ExecutionMode` and the manager's existing `lastSync` arguments.
- Produces: `PolicyTimer.setCadence(number | null)`, one coalesced `BackgroundChatManager.resume()` refresh, and `data-risk-execution-mode` on `<html>`.

- [ ] **Step 1: Write failing pause/resume/coalescing tests**

```typescript
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

it("coalesces repeated foreground resumes into one background sync", async () => {
  await manager.sync(groups, "Ana", iceServers);
  const sync = vi.spyOn(manager, "sync");
  await Promise.all([manager.resume(), manager.resume()]);
  expect(sync).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @risk/web test -- src/performance/policy-timer.test.ts src/services/chat/background-manager.test.ts`

Expected: FAIL because `PolicyTimer` and `resume` are absent.

- [ ] **Step 3: Implement policy-owned cadence and one resume refresh**

```typescript
export class PolicyTimer {
  private handle?: ReturnType<typeof setTimeout>;
  private cadence: number | null = null;
  constructor(private readonly callback: () => void) {}
  setCadence(cadence: number | null): void {
    this.stop();
    this.cadence = cadence;
    if (cadence !== null) this.schedule();
  }
  stop(): void { if (this.handle) clearTimeout(this.handle); this.handle = undefined; }
  private schedule(): void {
    const cadence = this.cadence;
    if (cadence === null) return;
    this.handle = setTimeout(() => { this.callback(); this.schedule(); }, cadence);
  }
}
```

Use it for the invite expiry display with cadence `1_000` in visible modes and `null` in `idle-hidden`. The bridge sets `document.documentElement.dataset.riskExecutionMode` and calls `backgroundChats.resume()` once on hidden-to-visible transition. `resume()` reuses the existing operation queue and last sync arguments. Add a hidden-mode CSS rule that pauses animation timelines without changing visible styles.

- [ ] **Step 4: Run PR-1 web tests and capture the after report**

Run: `pnpm --filter @risk/web test`

Expected: PASS; hidden invite display does not tick and one foreground refresh reconciles stale state.

Capture identical 60-second scenarios into `performance-results/pr1-after/` and compare them with `performance-results/pr1-baseline/` using `pnpm performance:report`.

- [ ] **Step 5: Commit and run the PR-1 verification set**

```bash
git add apps/web/src/performance/policy-timer.ts apps/web/src/performance/policy-timer.test.ts apps/web/src/components/P2PInvitePanel.tsx apps/web/src/performance/PerformanceRuntimeBridge.tsx apps/web/src/services/chat/background-manager.ts apps/web/src/services/chat/background-manager.test.ts apps/web/src/styles.css
git commit -m "perf(runtime): suspend hidden UI cadence"
```

Run separately:

- `pnpm --filter @risk/web test`
- `pnpm --filter @risk/desktop test`
- `pnpm typecheck`
- `pnpm build:desktop`

Expected: all exit 0; packaged startup, tray hide/restore, notifications, active transfer, and background call pass the documented checks.

## PR 1 Exit Gate

- Policy tests cover the full lifecycle/activity matrix.
- Hidden transfers remain `idle-hidden` but deny Chromium throttling.
- The coordinator contains no feature imports or imperative feature calls.
- Packaged background calls, transfers, presence, and notifications remain functional.
- Baseline and after reports use identical target-machine conditions.
