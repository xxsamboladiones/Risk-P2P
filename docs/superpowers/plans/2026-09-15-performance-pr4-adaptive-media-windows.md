# Performance PR 4: Adaptive Media and Windows Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic screen-share adaptation with user-request ceilings and evidence-based Windows GPU fallback, then verify the complete performance architecture on the target machine.

**Architecture:** Pure profile ladders and an `AdaptiveMediaState` reducer classify cached two-second aggregate samples, continue classification during cooldown, and request one-rung transitions through the performance policy. MediaManager applies deduplicated effective profiles; Electron records repeated GPU-process failures for next-launch fallback without disabling acceleration based on CPU age.

**Tech Stack:** TypeScript, WebRTC stats/sender parameters, MediaStreamTrack constraints, Electron 43, Node filesystem, Vitest, packaged Windows benchmarks.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-windows-performance-design.md`

## Global Constraints

- Ordinary ladder: `1080p30 -> 720p30 -> 480p30`.
- 60 FPS/game ladder: `1080p60 -> 720p60 -> 480p60 -> 480p30`.
- Never adapt below 854x480 at 30 FPS.
- `requestedProfile` is a hard recovery ceiling; `effectiveProfile` is the applied profile.
- Sample every two seconds while screen publication is active.
- Two consecutive bad samples enter warning; four enter overloaded and permit one-rung reduction.
- Fifteen consecutive healthy samples permit one-rung recovery.
- Profile changes have a twenty-second cooldown; sampling/classification continue during it.
- Missing metrics preserve state and never trigger a transition.
- Keep Windows hardware acceleration unless repeated GPU-process failure is observed or an explicit override is set.
- Preserve all existing uncommitted game/capture/GPU work and stage only task files.

---

## File Structure

- `apps/web/src/services/rtc/screen-quality.ts`: complete profile catalog and ordered ladders.
- `apps/web/src/performance/media-pressure.ts`: pure sample classification and adaptive reducer.
- `apps/web/src/performance/media-signal-adapter.ts`: maps cached diagnostics/long tasks to aggregate samples.
- `apps/web/src/call/AdaptiveScreenController.ts`: policy consumer applying effective profiles.
- `apps/desktop/src/gpu-health.ts`: persisted repeated-failure decision and recovery.
- `scripts/performance/verify-adaptation-report.mjs`: validates rung/cooldown/ceiling evidence.

### Task 1: Complete screen profile catalog and ladders

**Files:**
- Modify: `apps/web/src/services/rtc/screen-quality.ts`
- Modify: `apps/web/src/services/rtc/screen-quality.test.ts`
- Modify: `apps/web/src/components/CallWorkspace.tsx`

**Interfaces:**
- Consumes: existing `ScreenQualityProfile` and publication mapping.
- Produces: `ScreenProfile`, `SCREEN_PROFILE_LADDERS`, `nextLowerProfile`, `nextHigherProfile`; adds `480p30` and `480p60`.

- [ ] **Step 1: Write failing exact-ladder and floor tests**

```typescript
it("defines deterministic 30 and 60 FPS ladders", () => {
  expect(SCREEN_PROFILE_LADDERS.standard).toEqual(["480p30", "720p30", "1080p30"]);
  expect(SCREEN_PROFILE_LADDERS.motion).toEqual(["480p30", "480p60", "720p60", "1080p60"]);
});

it("never descends below 480p30 and never recovers above the request", () => {
  expect(nextLowerProfile("480p30")).toBe("480p30");
  expect(nextHigherProfile("480p30", "720p60")).toBe("480p60");
  expect(nextHigherProfile("720p60", "720p60")).toBe("720p60");
});

it("maps 480p profiles to exact capture constraints", () => {
  expect(SCREEN_QUALITY_PROFILES["480p30"]).toMatchObject({ width: 854, height: 480, fps: 30 });
  expect(SCREEN_QUALITY_PROFILES["480p60"]).toMatchObject({ width: 854, height: 480, fps: 60 });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @risk/web test -- src/services/rtc/screen-quality.test.ts`

Expected: FAIL because the profiles and ladders are missing.

- [ ] **Step 3: Implement typed profiles and ladder helpers**

```typescript
export type ScreenProfile = "480p30" | "720p30" | "1080p30" | "480p60" | "720p60" | "1080p60";
export type ScreenQuality = ScreenProfile;
export const SCREEN_PROFILE_LADDERS = {
  standard: ["480p30", "720p30", "1080p30"],
  motion: ["480p30", "480p60", "720p60", "1080p60"],
} as const satisfies Record<string, readonly ScreenProfile[]>;

export function nextHigherProfile(effective: ScreenProfile, requested: ScreenProfile): ScreenProfile {
  const ladder = requested.endsWith("60") ? SCREEN_PROFILE_LADDERS.motion : SCREEN_PROFILE_LADDERS.standard;
  const effectiveIndex = Math.max(0, ladder.indexOf(effective));
  const ceiling = ladder.indexOf(requested);
  return ladder[Math.min(effectiveIndex + 1, ceiling)] ?? requested;
}
```

Implement `nextLowerProfile` with the ladder containing the current profile and clamp index at zero. Keep 480 profiles available to adaptation but hide them from the normal manual selector unless product UI explicitly needs them later.

- [ ] **Step 4: Run screen quality and call UI tests**

Run: `pnpm --filter @risk/web test -- src/services/rtc/screen-quality.test.ts src/call/MediaManager.test.ts`

Expected: PASS; publication options for existing profiles remain unchanged.

- [ ] **Step 5: Commit profile ladders**

```bash
git add apps/web/src/services/rtc/screen-quality.ts apps/web/src/services/rtc/screen-quality.test.ts apps/web/src/components/CallWorkspace.tsx
git commit -m "feat(media): define adaptive screen profile ladders"
```

### Task 2: Pure media-pressure reducer

**Files:**
- Create: `apps/web/src/performance/media-pressure.ts`
- Create: `apps/web/src/performance/media-pressure.test.ts`
- Modify: `apps/web/src/performance/policy.ts`

**Interfaces:**
- Consumes: `ScreenProfile`, ladder helpers, timestamped `MediaLoadSample` classified as `bad`, `healthy`, or `missing`.
- Produces: `AdaptiveMediaState`, `initialAdaptiveMediaState(requested)`, `reduceMediaPressure(state, sample)`.

- [ ] **Step 1: Write failing transition-table tests**

```typescript
it("warns at two bad samples and reduces one rung at four", () => {
  let state = initialAdaptiveMediaState("1080p30");
  state = bad(state, 2_000);
  state = bad(state, 4_000);
  expect(state).toMatchObject({ mediaPressure: "warning", effectiveProfile: "1080p30", overloadSamples: 2 });
  state = bad(state, 6_000);
  state = bad(state, 8_000);
  expect(state).toMatchObject({ mediaPressure: "overloaded", effectiveProfile: "720p30", cooldownUntil: 28_000 });
});

it("classifies throughout cooldown but blocks profile transitions", () => {
  let state = overloadedAt720p30WithCooldownUntil(28_000);
  state = bad(state, 10_000);
  state = bad(state, 12_000);
  state = bad(state, 14_000);
  state = bad(state, 16_000);
  expect(state.mediaPressure).toBe("overloaded");
  expect(state.effectiveProfile).toBe("720p30");
  state = bad(state, 28_000);
  expect(state.effectiveProfile).toBe("480p30");
});

it("recovers one rung after fifteen healthy samples and stops at requested profile", () => {
  let state = constrainedState({ requestedProfile: "720p60", effectiveProfile: "480p30", cooldownUntil: null });
  state = repeatHealthy(state, 15, 2_000);
  expect(state.effectiveProfile).toBe("480p60");
  state = repeatHealthy({ ...state, cooldownUntil: null }, 15, 40_000);
  expect(state.effectiveProfile).toBe("720p60");
  state = repeatHealthy({ ...state, cooldownUntil: null }, 15, 80_000);
  expect(state.effectiveProfile).toBe("720p60");
});
```

- [ ] **Step 2: Run the reducer test and verify RED**

Run: `pnpm --filter @risk/web test -- src/performance/media-pressure.test.ts`

Expected: FAIL because the reducer is absent.

- [ ] **Step 3: Implement the explicit state machine**

```typescript
export type AdaptiveMediaState = {
  requestedProfile: ScreenProfile;
  effectiveProfile: ScreenProfile;
  mediaPressure: MediaPressure;
  overloadSamples: number;
  recoverySamples: number;
  lastTransitionAt: number | null;
  cooldownUntil: number | null;
};
export type MediaLoadSample = { classification: "bad" | "healthy" | "missing"; sampledAt: number };

const WARNING_SAMPLES = 2;
const OVERLOAD_SAMPLES = 4;
const RECOVERY_SAMPLES = 15;
const COOLDOWN_MS = 20_000;
```

Implement a total reducer with no timers: missing returns the same state; bad increments overload and clears recovery; healthy increments recovery and clears overload. Update pressure even inside cooldown. Only transition when `sampledAt >= cooldownUntil`, and move exactly one rung. A user-request change clamps recovery ceiling immediately but never jumps upward more than one rung.

- [ ] **Step 4: Run reducer tests including table-driven boundaries**

Add cases at samples 1/2/3/4, timestamps `cooldownUntil - 1` and `cooldownUntil`, missing samples, bad-after-recovery, healthy-before-overload, all requested ceilings, and both ladders.

Run: `pnpm --filter @risk/web test -- src/performance/media-pressure.test.ts`

Expected: PASS for every transition row.

- [ ] **Step 5: Commit the pure reducer**

```bash
git add apps/web/src/performance/media-pressure.ts apps/web/src/performance/media-pressure.test.ts apps/web/src/performance/policy.ts
git commit -m "feat(performance): add deterministic media pressure state"
```

### Task 3: Aggregate media signal classification

**Files:**
- Create: `apps/web/src/performance/media-signal-adapter.ts`
- Create: `apps/web/src/performance/media-signal-adapter.test.ts`
- Modify: `packages/rtc/src/diagnostics/stats.ts`
- Modify: `packages/rtc/src/diagnostics/stats.test.ts`
- Modify: `packages/rtc/src/transport/call-transport.ts`

**Interfaces:**
- Consumes: cached peer diagnostics, renderer long-task/event-loop sample, actual outbound profile.
- Produces: one `MediaLoadSample` every two seconds; no new `getStats()` call.

- [ ] **Step 1: Write failing signal precedence tests**

```typescript
it.each([
  [{ videoEncodeMs: 24 }, "bad"],
  [{ framesDroppedDelta: 8, framesEncodedDelta: 100 }, "bad"],
  [{ eventLoopDelayMs: 90 }, "bad"],
  [{ availableOutgoingKbps: 12_000, videoEncodeMs: 8, eventLoopDelayMs: 12, framesDroppedDelta: 0, framesEncodedDelta: 100 }, "healthy"],
  [{ availableOutgoingKbps: undefined, videoEncodeMs: undefined }, "missing"],
])("classifies %j as %s", (signals, classification) => {
  expect(classifyMediaLoad(signals)).toBe(classification);
});
```

- [ ] **Step 2: Run web/RTC tests and verify RED**

Run: `pnpm --filter @risk/web test -- src/performance/media-signal-adapter.test.ts`

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Extend cached summaries and implement conservative classification**

Add cumulative `framesEncoded` and `framesDropped` extraction to `summarizePeerStats`; compute deltas in the PR-2 diagnostics sampler. Classify bad when any confirmed encoder/main-thread threshold is exceeded, healthy only when every required local-load metric is present and below its healthy threshold, otherwise missing. Network-only congestion remains a transport/bitrate signal and must not falsely diagnose CPU pressure.

```typescript
export function classifyMediaLoad(input: MediaLoadSignals): MediaLoadSample["classification"] {
  if (isConfirmedBad(input)) return "bad";
  if (hasCompleteHealthyEvidence(input) && isHealthy(input)) return "healthy";
  return "missing";
}
```

- [ ] **Step 4: Run RTC stats and adapter tests**

Run: `pnpm --filter @risk/rtc test -- src/diagnostics/stats.test.ts`

Expected: PASS with accurate frame counters.

Run: `pnpm --filter @risk/web test -- src/performance/media-signal-adapter.test.ts src/call/CallDiagnosticsSampler.test.ts`

Expected: PASS; counter instrumentation proves no extra stats query.

- [ ] **Step 5: Commit cached signal classification**

```bash
git add apps/web/src/performance/media-signal-adapter.ts apps/web/src/performance/media-signal-adapter.test.ts packages/rtc/src/diagnostics/stats.ts packages/rtc/src/diagnostics/stats.test.ts packages/rtc/src/transport/call-transport.ts
git commit -m "feat(performance): classify cached media load signals"
```

### Task 4: Adaptive screen policy consumer

**Files:**
- Create: `apps/web/src/call/AdaptiveScreenController.ts`
- Create: `apps/web/src/call/AdaptiveScreenController.test.ts`
- Modify: `apps/web/src/call/CallController.ts`
- Modify: `apps/web/src/call/CallController.test.ts`
- Modify: `apps/web/src/call/MediaManager.ts`
- Modify: `apps/web/src/call/MediaManager.test.ts`
- Modify: `apps/web/src/call/game/quality-policy.ts`
- Modify: `apps/web/src/call/game/quality-policy.test.ts`
- Modify: `apps/web/src/call/game/GameModeController.ts`
- Modify: `apps/web/src/call/game/GameModeController.test.ts`

**Interfaces:**
- Consumes: requested screen profile changes, two-second cached load samples, `reduceMediaPressure`, `MediaManager.updateScreenQuality`.
- Produces: `AdaptiveScreenController.request(profile)`, `.sample(sample)`, `.reset()`; effective-profile changes only.

- [ ] **Step 1: Write failing application-boundary tests**

```typescript
it("applies only changed effective profiles and preserves the user ceiling", async () => {
  const apply = vi.fn(async () => undefined);
  const controller = new AdaptiveScreenController(apply, "720p60");
  for (let index = 1; index <= 4; index += 1) controller.sample({ classification: "bad", sampledAt: index * 2_000 });
  expect(apply).toHaveBeenLastCalledWith("480p60");
  controller.request("720p60");
  expect(apply).toHaveBeenCalledTimes(1);
});

it("keeps publication alive when applying a lower profile fails", async () => {
  const apply = vi.fn().mockRejectedValueOnce(new Error("constraints"));
  const controller = new AdaptiveScreenController(apply, "1080p30");
  await feedFourBadSamples(controller);
  expect(controller.getSnapshot().effectiveProfile).toBe("1080p30");
  expect(controller.getSnapshot().lastError).toContain("constraints");
});
```

- [ ] **Step 2: Run call tests and verify RED**

Run: `pnpm --filter @risk/web test -- src/call/AdaptiveScreenController.test.ts`

Expected: FAIL because the controller is absent.

- [ ] **Step 3: Implement adapter and replace the old game policy**

The adapter serializes profile applications, commits reducer state only after `MediaManager.updateScreenQuality` succeeds, and keeps the last valid effective profile on failure. `CallController.updateScreenQuality` updates `requestedProfile`; joining/leaving screen publication starts/stops the two-second sampling loop. Game mode sets a `1080p60` recovery ceiling but starts at the current `720p60` effective profile, then uses the shared four-rung reducer instead of its current two-profile `gameQuality` decision. The coordinator receives resulting `mediaPressure` and `effectiveScreenProfile`; it does not call MediaManager.

```typescript
if (next.effectiveProfile !== current.effectiveProfile) {
  await this.apply(next.effectiveProfile);
}
this.state = next;
this.emit();
```

- [ ] **Step 4: Run media, game, call, and RTC tests**

Run separately:

- `pnpm --filter @risk/web test -- src/call/AdaptiveScreenController.test.ts src/call/MediaManager.test.ts src/call/CallController.test.ts src/call/game/quality-policy.test.ts src/call/game/GameModeController.test.ts`
- `pnpm --filter @risk/rtc test`
- `pnpm --filter @risk/web typecheck`

Expected: all exit 0; track IDs and peer connections remain unchanged through profile transitions.

- [ ] **Step 5: Commit adaptive application wiring**

```bash
git add apps/web/src/call/AdaptiveScreenController.ts apps/web/src/call/AdaptiveScreenController.test.ts apps/web/src/call/CallController.ts apps/web/src/call/CallController.test.ts apps/web/src/call/MediaManager.ts apps/web/src/call/MediaManager.test.ts apps/web/src/call/game/quality-policy.ts apps/web/src/call/game/quality-policy.test.ts apps/web/src/call/game/GameModeController.ts apps/web/src/call/game/GameModeController.test.ts
git commit -m "feat(media): adapt screen quality with hysteresis"
```

### Task 5: Evidence-based Windows GPU fallback

**Files:**
- Create: `apps/desktop/src/gpu-health.ts`
- Create: `apps/desktop/src/gpu-health.test.ts`
- Modify: `apps/desktop/src/gpu.ts`
- Modify: `apps/desktop/src/gpu.test.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: persisted `GpuHealthRecord`, `app.on("child-process-gone")` details, explicit `RISK_FORCE_GPU`/`RISK_DISABLE_GPU` overrides.
- Produces: `shouldUseWindowsSoftwareRendering(record, now)` and bounded `recordGpuFailure`/`recordHealthySession` persistence.

- [ ] **Step 1: Write failing decision tests**

```typescript
it("does not disable acceleration for old CPUs or a single GPU crash", () => {
  expect(shouldUseWindowsSoftwareRendering(undefined, now)).toBe(false);
  expect(shouldUseWindowsSoftwareRendering({ failures: [now - 1_000], healthyLaunches: 0 }, now)).toBe(false);
});

it("uses next-launch fallback after two recent GPU process crashes", () => {
  expect(shouldUseWindowsSoftwareRendering({ failures: [now - 60_000, now - 1_000], healthyLaunches: 0 }, now)).toBe(true);
});

it("clears fallback after three explicitly forced healthy launches", () => {
  const record = recordHealthySession({ failures: [now - 1_000, now - 500], healthyLaunches: 2 }, true);
  expect(record).toEqual({ failures: [], healthyLaunches: 0 });
});
```

- [ ] **Step 2: Run desktop GPU tests and verify RED**

Run: `pnpm --filter @risk/desktop test -- src/gpu-health.test.ts src/gpu.test.ts`

Expected: FAIL because persisted Windows health policy is missing.

- [ ] **Step 3: Implement bounded next-launch evidence**

Persist only timestamps from the last ten minutes, maximum eight entries, in `app.getPath("userData")/gpu-health.json`. Two `child-process-gone` events whose type is `GPU` within ten minutes mark next-launch software fallback. `RISK_FORCE_GPU=1` overrides the marker and counts a healthy session only after ten minutes without a GPU crash; three forced healthy sessions clear it. `RISK_DISABLE_GPU=1` remains an explicit override. Parse errors default to acceleration.

```typescript
export function shouldUseWindowsSoftwareRendering(record: GpuHealthRecord | undefined, now: number): boolean {
  return (record?.failures.filter((at) => now - at <= 600_000).length ?? 0) >= 2;
}
```

Call `app.disableHardwareAcceleration()` only in pre-ready `configurePlatformRuntime`. Register failure recording after ready; never relaunch automatically.

- [ ] **Step 4: Run desktop tests and packaged GPU smoke check**

Run: `pnpm --filter @risk/desktop test -- src/gpu-health.test.ts src/gpu.test.ts src/main.test.ts`

Expected: PASS.

Run: `pnpm build:desktop`

Expected: packaged Risk starts accelerated with no marker and honors both explicit overrides.

- [ ] **Step 5: Commit GPU fallback**

```bash
git add apps/desktop/src/gpu-health.ts apps/desktop/src/gpu-health.test.ts apps/desktop/src/gpu.ts apps/desktop/src/gpu.test.ts apps/desktop/src/main.ts apps/desktop/package.json
git commit -m "fix(windows): gate software rendering on GPU failure evidence"
```

### Task 6: Final adaptation report and approach-3 gate

**Files:**
- Create: `scripts/performance/verify-adaptation-report.mjs`
- Create: `docs/performance/final-windows-report.md`
- Modify: `package.json`
- Modify: `docs/performance/windows-scenarios.md`

**Interfaces:**
- Consumes: PR-1 versioned reports and recorded profile-transition events.
- Produces: `pnpm verify:performance-adaptation -- report.json`; final same-machine comparison and explicit rewrite eligibility decision per module.

- [ ] **Step 1: Write failing report-fixture validation**

Create fixtures with requested/effective profiles and timestamps. The verifier must reject:

```json
{
  "requestedProfile": "720p60",
  "transitions": [
    { "at": 8000, "from": "720p60", "to": "480p30" },
    { "at": 30000, "from": "480p30", "to": "1080p60" }
  ]
}
```

It must accept transitions `720p60 -> 480p60 -> 480p30 -> 480p60 -> 720p60` when reductions/recoveries are one rung and at least 20 seconds apart.

- [ ] **Step 2: Run the verifier against invalid and valid fixtures**

Run: `node scripts/performance/verify-adaptation-report.mjs scripts/performance/fixtures/adaptation-invalid.json`

Expected: exit 1 naming the skipped rung and exceeded requested ceiling.

Run: `node scripts/performance/verify-adaptation-report.mjs scripts/performance/fixtures/adaptation-valid.json`

Expected: exit 0.

- [ ] **Step 3: Implement complete report validation**

Validate schema version, 2-second sample cadence tolerance, warning/overload counts, cooldown spacing, ladder adjacency, 480p/30 floor, requested ceiling, classification updates during cooldown, and unchanged media track IDs across transitions. Print errors as scenario/timestamp/rule triples.

```javascript
if (toIndex > requestedIndex) failures.push(`${scenario}@${at}: recovery exceeded requestedProfile`);
if (Math.abs(toIndex - fromIndex) > 1) failures.push(`${scenario}@${at}: transition skipped a rung`);
```

- [ ] **Step 4: Execute final verification and target-machine scenarios**

Run separately:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build:desktop`
- `pnpm verify:initial-chunks`
- `pnpm verify:performance-adaptation -- performance-results/final/adaptation.json`

Expected: all automated commands exit 0. Run all nine 60-second scenarios from `docs/performance/windows-scenarios.md` on the same Windows 10+ target machine and compare against PR-1 baseline.

- [ ] **Step 5: Write the evidence table and apply the rewrite gate**

For each scenario, record baseline/final CPU, working set, long tasks, stats calls, mounted rows, active visual analysers, and effective profiles. For every candidate module, record main-thread self-time share and retained-heap share. Mark approach 3 `eligible` only if either share is at least 25 percent and bounded optimizations failed; otherwise mark `not eligible` with the measured shares.

If a module is eligible, stop after recording the evidence and create a separate module-specific design/implementation plan behind its existing public interface. Do not improvise an unplanned rewrite inside PR 4.

```bash
git add scripts/performance/verify-adaptation-report.mjs scripts/performance/fixtures/adaptation-invalid.json scripts/performance/fixtures/adaptation-valid.json docs/performance/final-windows-report.md docs/performance/windows-scenarios.md package.json
git commit -m "test(performance): verify Windows adaptation and final gains"
```

## PR 4 Exit Gate

- Every transition is adjacent, cooldown-compliant, and no lower than 480p/30.
- Recovery stops at the requested profile.
- Pressure classification continues during cooldown.
- Adaptation reuses cached stats and preserves track/connection identity.
- GPU acceleration remains the default and fallback requires repeated observed failure.
- Full tests, typechecks, web/desktop builds, packaged checks, and nine target-machine scenarios pass.
- Final report attributes gains per PR and makes no unsupported percentage claim.
- Approach 3 is used only for a measured module meeting the 25 percent gate.
