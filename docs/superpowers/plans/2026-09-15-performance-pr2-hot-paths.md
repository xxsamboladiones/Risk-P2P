# Performance PR 2: Call Hot Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unnecessary recurring renderer and WebRTC work during calls, especially when the call workspace is hidden, while preserving transport, receiving tracks, audio, recovery, and normal visible presentation.

**Architecture:** Consumers subscribe to the PR-1 `PerformancePolicy` and execute only local responsibilities. Visual VAD, diagnostics, HTML video presentation, local preview identity, and React render boundaries are optimized independently so each gain is measurable.

**Tech Stack:** TypeScript, React 19, Zustand, Web Audio API, HTMLMediaElement, WebRTC stats, Vitest, PR-1 benchmark harness.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-windows-performance-design.md`

## Global Constraints

- Primary platform is Windows 10 and newer.
- Preserve media connections, receiving tracks, remote audio, signaling, recovery, and current visible styling.
- Disable only visual VAD; any semantic VAD contract remains independent and active.
- One shared stats sample per peer per interval; consumers read cached summaries.
- Hidden-video tests assert outcomes, not a required `pause()` or `srcObject = null` mechanism.
- Preserve existing uncommitted screen/game/call changes and stage only task files.
- Record benchmark deltas after each task group; do not attribute combined later gains to an earlier task.

---

## File Structure

- `apps/web/src/services/audio/visual-voice-activity.ts`: visual-only observer contract.
- `apps/web/src/call/CallDiagnosticsSampler.ts`: single cadence and cached diagnostic store.
- `apps/web/src/call/media/video-presentation.ts`: DOM adapter for video-only presentation.
- `apps/web/src/call/media/preview-cache.ts`: stable local preview stream identities.
- `apps/web/src/components/CallStage.tsx`: isolated grid subscription/render boundary.
- `apps/web/src/components/CallDiagnosticsPanel.tsx`: isolated diagnostic boundary.

### Task 1: Visual VAD policy gate

**Files:**
- Create: `apps/web/src/services/audio/visual-voice-activity.ts`
- Create: `apps/web/src/services/audio/visual-voice-activity.test.ts`
- Modify: `apps/web/src/services/audio/voice-activity.ts`
- Modify: `apps/web/src/components/CallWorkspace.tsx`

**Interfaces:**
- Consumes: `PerformancePolicy.visualVoiceActivityEnabled` from PR 1.
- Produces: `observeVisualVoiceActivity(stream, enabled, onChange)`; existing `observeVoiceActivity` remains the low-level analyser and is not named semantic.

- [ ] **Step 1: Write the failing visual-only lifecycle test**

```typescript
it("does not allocate an analyser when visual voice activity is disabled", () => {
  const observe = vi.fn(() => vi.fn());
  const cleanup = observeVisualVoiceActivity(stream, false, vi.fn(), observe);
  expect(observe).not.toHaveBeenCalled();
  cleanup();
});

it("clears the speaking border when policy disables visual VAD", () => {
  const changes: boolean[] = [];
  const stop = vi.fn();
  const cleanup = observeVisualVoiceActivity(stream, true, (value) => changes.push(value), () => stop);
  cleanup();
  expect(changes.at(-1)).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @risk/web test -- src/services/audio/visual-voice-activity.test.ts`

Expected: FAIL because the visual adapter is absent.

- [ ] **Step 3: Implement and consume the visual gate**

```typescript
export function observeVisualVoiceActivity(
  stream: MediaStream,
  enabled: boolean,
  onChange: (speaking: boolean) => void,
  observe = observeVoiceActivity,
): () => void {
  if (!enabled) { onChange(false); return () => undefined; }
  const stop = observe(stream, onChange);
  return () => { stop(); onChange(false); };
}
```

Change `useVoiceActivity` to accept `visualVoiceActivityEnabled` and use `observeVisualVoiceActivity`. Pass the coordinator policy separately from participant audibility. Do not add a generic `voiceActivityEnabled` flag.

- [ ] **Step 4: Run audio and call-workspace tests**

Run: `pnpm --filter @risk/web test -- src/services/audio/voice-activity.test.ts src/services/audio/visual-voice-activity.test.ts src/components/call-layout.test.ts`

Expected: PASS; hidden/minimized policy allocates zero visual analysers.

- [ ] **Step 5: Commit and record the VAD benchmark delta**

Capture the visible-call and minimized-call scenarios before and after this commit, then:

```bash
git add apps/web/src/services/audio/visual-voice-activity.ts apps/web/src/services/audio/visual-voice-activity.test.ts apps/web/src/services/audio/voice-activity.ts apps/web/src/components/CallWorkspace.tsx
git commit -m "perf(call): suspend visual voice analysis when hidden"
```

### Task 2: Shared diagnostics sampler

**Files:**
- Create: `apps/web/src/call/CallDiagnosticsSampler.ts`
- Create: `apps/web/src/call/CallDiagnosticsSampler.test.ts`
- Modify: `apps/web/src/call/CallController.ts`
- Modify: `apps/web/src/components/CallWorkspace.tsx`
- Modify: `apps/web/src/call/CallController.test.ts`

**Interfaces:**
- Consumes: `PerformancePolicy.diagnosticsIntervalMs`, existing `CallController.collectLiveDiagnostics()` logic, and `CallTransport.collectDiagnostics()`.
- Produces: `CallDiagnosticsSampler.start(intervalMs)`, `.stop()`, `.refresh()`, `.getSnapshot()`, `.subscribe()`; `CallController.diagnostics` exposes the sampler.

- [ ] **Step 1: Write failing fake-clock tests**

```typescript
it("shares one collection across subscribers and changes cadence without overlap", async () => {
  vi.useFakeTimers();
  const collect = vi.fn(async () => diagnostics);
  const sampler = new CallDiagnosticsSampler(collect);
  sampler.subscribe(vi.fn());
  sampler.subscribe(vi.fn());
  sampler.start(3_000);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(collect).toHaveBeenCalledTimes(3);
  sampler.start(10_000);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(collect).toHaveBeenCalledTimes(5);
});

it("performs no collection when cadence is null", async () => {
  sampler.start(null);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(collect).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the sampler test and verify RED**

Run: `pnpm --filter @risk/web test -- src/call/CallDiagnosticsSampler.test.ts`

Expected: FAIL because the sampler is missing.

- [ ] **Step 3: Implement a non-overlapping cached external store**

```typescript
export class CallDiagnosticsSampler {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private intervalMs: number | null = null;
  private snapshot: CallDiagnostics | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly collect: () => Promise<CallDiagnostics>) {}
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  start(intervalMs: number | null): void {
    if (this.intervalMs === intervalMs) return;
    this.stop();
    this.intervalMs = intervalMs;
    if (intervalMs !== null) this.schedule(intervalMs);
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.intervalMs = null;
  }
  async refresh(): Promise<CallDiagnostics | null> {
    this.running ??= this.collect().then((value) => {
      this.snapshot = value;
      this.listeners.forEach((listener) => listener());
    }).finally(() => { this.running = undefined; });
    await this.running;
    return this.snapshot;
  }
  private schedule(intervalMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().finally(() => {
        if (this.intervalMs === intervalMs) this.schedule(intervalMs);
      });
    }, intervalMs);
  }
}
```

Move the body of `getLiveDiagnostics()` into a private collection method. Keep `getLiveDiagnostics()` as `sampler.refresh()` compatibility. Apply `game.adapt` exactly once per collected sample. `CallWorkspace` subscribes with `useSyncExternalStore` and updates cadence from policy.

- [ ] **Step 4: Run call, Mesh, and sampler tests**

Run: `pnpm --filter @risk/web test -- src/call/CallDiagnosticsSampler.test.ts src/call/CallController.test.ts`

Expected: PASS; concurrent panel refresh and periodic cadence share one collection.

Run: `pnpm --filter @risk/rtc test -- src/diagnostics/stats.test.ts src/index.test.ts`

Expected: PASS with unchanged stats summaries.

- [ ] **Step 5: Commit and record stats-call counters**

```bash
git add apps/web/src/call/CallDiagnosticsSampler.ts apps/web/src/call/CallDiagnosticsSampler.test.ts apps/web/src/call/CallController.ts apps/web/src/components/CallWorkspace.tsx apps/web/src/call/CallController.test.ts
git commit -m "perf(rtc): consolidate live diagnostics sampling"
```

### Task 3: Hidden video presentation adapter

**Files:**
- Create: `apps/web/src/call/media/video-presentation.ts`
- Create: `apps/web/src/call/media/video-presentation.test.ts`
- Modify: `apps/web/src/components/CallWorkspace.tsx`

**Interfaces:**
- Consumes: a video-only `MediaStream`, `HTMLVideoElement`, and `hiddenVideoPresentationEnabled`.
- Produces: `VideoPresentationController.update({ stream, visible })` and `.dispose()`.

- [ ] **Step 1: Write failing outcome tests with a fake video element**

```typescript
it("stops hidden video presentation without mutating tracks", async () => {
  const track = fakeTrack("video");
  const stream = fakeStream([track]);
  const element = fakeVideoElement();
  const controller = new VideoPresentationController(element);
  await controller.update({ stream, visible: true });
  await controller.update({ stream, visible: false });
  expect(element.srcObject).toBeNull();
  expect(track.enabled).toBe(true);
  expect(track.stop).not.toHaveBeenCalled();
});

it("never receives audio tracks", async () => {
  const stream = fakeStream([fakeTrack("video"), fakeTrack("audio")]);
  await controller.update({ stream, visible: true });
  expect((element.srcObject as MediaStream).getAudioTracks()).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @risk/web test -- src/call/media/video-presentation.test.ts`

Expected: FAIL because the controller is absent.

- [ ] **Step 3: Implement the adapter without touching connection/audio**

```typescript
export class VideoPresentationController {
  constructor(private readonly element: HTMLVideoElement) {}
  async update({ stream, visible }: { stream?: MediaStream; visible: boolean }): Promise<void> {
    const videoOnly = visible && stream ? new MediaStream(stream.getVideoTracks()) : null;
    if (sameTrackIds(this.element.srcObject as MediaStream | null, videoOnly)) return;
    this.element.srcObject = videoOnly;
    if (videoOnly) await this.element.play().catch(() => undefined);
  }
  dispose(): void { this.element.srcObject = null; }
}
```

Use one controller per tile. Keep the existing independent `<RemoteAudio>` components mounted. Visibility is true only when the call workspace, tile source, and document presentation policy permit it.

- [ ] **Step 4: Run video, audio playback, and call tests**

Run: `pnpm --filter @risk/web test -- src/call/media/video-presentation.test.ts src/services/audio/remote-playback.test.ts src/call/ParticipantManager.test.ts`

Expected: PASS; remote audio remains mounted and receiving tracks remain enabled.

- [ ] **Step 5: Commit and capture minimized-call CPU**

```bash
git add apps/web/src/call/media/video-presentation.ts apps/web/src/call/media/video-presentation.test.ts apps/web/src/components/CallWorkspace.tsx
git commit -m "perf(call): suspend hidden video presentation"
```

### Task 4: Stable local preview identities

**Files:**
- Create: `apps/web/src/call/media/preview-cache.ts`
- Create: `apps/web/src/call/media/preview-cache.test.ts`
- Modify: `apps/web/src/call/MediaManager.ts`
- Modify: `apps/web/src/call/MediaManager.test.ts`
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/store.test.ts`

**Interfaces:**
- Consumes: current microphone, camera, and screen tracks.
- Produces: `MediaPreviewCache.snapshot(tracks)` returning the same `LocalMediaPreviews` object and stream identities when track IDs are unchanged.

- [ ] **Step 1: Write a failing identity test**

```typescript
it("reuses preview objects when unrelated peer state changes", () => {
  const cache = new MediaPreviewCache();
  const first = cache.snapshot({ microphone, camera, screen: [screenTrack] });
  const second = cache.snapshot({ microphone, camera, screen: [screenTrack] });
  expect(second).toBe(first);
  expect(second.microphone).toBe(first.microphone);
  expect(second.screen).toBe(first.screen);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @risk/web test -- src/call/media/preview-cache.test.ts src/store.test.ts`

Expected: FAIL because the cache is missing.

- [ ] **Step 3: Implement keyed stream reuse and store equality**

Cache streams by ordered `kind:id` signatures. Return `null` for no tracks. In `setLocalMedia`, skip the Zustand update when preview object identities and every `PeerState` field are unchanged. Replace direct `new MediaStream(...)` calls in `MediaManager.updateLocalPreview()` with the cache.

```typescript
if (sameLocalMedia(state.localPreviews, localPreviews) && samePeerState(state.localState, localState)) return state;
return { localPreviews, localState: { ...localState } };
```

- [ ] **Step 4: Run MediaManager/store suites**

Run: `pnpm --filter @risk/web test -- src/call/media/preview-cache.test.ts src/call/MediaManager.test.ts src/store.test.ts`

Expected: PASS; toggling state replaces only the affected preview.

- [ ] **Step 5: Commit stable preview identities**

```bash
git add apps/web/src/call/media/preview-cache.ts apps/web/src/call/media/preview-cache.test.ts apps/web/src/call/MediaManager.ts apps/web/src/call/MediaManager.test.ts apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "perf(media): reuse local preview streams"
```

### Task 5: Isolate call render boundaries

**Files:**
- Create: `apps/web/src/components/CallStage.tsx`
- Create: `apps/web/src/components/CallDiagnosticsPanel.tsx`
- Create: `apps/web/src/components/call-render-model.ts`
- Create: `apps/web/src/components/call-render-model.test.ts`
- Modify: `apps/web/src/components/CallWorkspace.tsx`
- Modify: `apps/web/src/components/call-workspace.css`

**Interfaces:**
- Consumes: stable participant/media selectors, cached diagnostics snapshot, and performance policy.
- Produces: `selectCallStageModel(state)` with referentially stable participant entries; memoized `CallStage`; independent `CallDiagnosticsPanel`.

- [ ] **Step 1: Write failing selector stability tests**

```typescript
it("keeps the stage model stable across diagnostics-only changes", () => {
  const first = selectCallStageModel(callState);
  const second = selectCallStageModel({ ...callState, error: "diagnostic warning" });
  expect(second).toBe(first);
});

it("replaces only the participant whose media changed", () => {
  const first = selectCallStageModel(callState);
  const second = selectCallStageModel(withChangedParticipant(callState, "peer-b"));
  expect(second.participants[0]).toBe(first.participants[0]);
  expect(second.participants[1]).not.toBe(first.participants[1]);
});
```

- [ ] **Step 2: Run the selector test and verify RED**

Run: `pnpm --filter @risk/web test -- src/components/call-render-model.test.ts`

Expected: FAIL because the selector is missing.

- [ ] **Step 3: Extract focused components and stable selectors**

Implement a module-level selector cache keyed by participant object identities and local preview identities. Move tile/grid code to `CallStage.tsx`, diagnostics markup/state to `CallDiagnosticsPanel.tsx`, and keep orchestration/chat controls in `CallWorkspace`. Wrap leaf tiles and stage with `memo` only after their props are stable; do not add blanket `useMemo` calls.

```typescript
export type CallStageProps = {
  model: CallStageModel;
  visualVoiceActivityEnabled: boolean;
  hiddenVideoPresentationEnabled: boolean;
  onFocus(tileId: string): void;
};

function CallStageImpl(props: CallStageProps) {
  return <section className={props.model.className}>{props.model.tiles.map((tile) => (
    <VideoTile key={tile.tileId} {...tile} onFocus={props.onFocus}
      visualVoiceActivityEnabled={props.visualVoiceActivityEnabled}
      videoPresentationEnabled={props.hiddenVideoPresentationEnabled}/>
  ))}</section>;
}

export const CallStage = memo(CallStageImpl);
```

- [ ] **Step 4: Run call UI tests, typecheck, and benchmark counters**

Run: `pnpm --filter @risk/web test -- src/components/call-render-model.test.ts src/components/call-layout.test.ts src/components/fullscreen-overlays.test.ts`

Expected: PASS with unchanged layout calculations.

Run: `pnpm --filter @risk/web typecheck`

Expected: exit 0. The benchmark render counter shows diagnostics updates do not commit `CallStage`.

- [ ] **Step 5: Commit and complete PR-2 verification**

```bash
git add apps/web/src/components/CallStage.tsx apps/web/src/components/CallDiagnosticsPanel.tsx apps/web/src/components/call-render-model.ts apps/web/src/components/call-render-model.test.ts apps/web/src/components/CallWorkspace.tsx apps/web/src/components/call-workspace.css
git commit -m "perf(call): isolate stage render boundaries"
```

Run separately:

- `pnpm --filter @risk/web test`
- `pnpm --filter @risk/rtc test`
- `pnpm typecheck`
- `pnpm build:desktop`

Expected: all exit 0, packaged visible/minimized calls preserve audio, tracks, recovery, controls, and appearance.

## PR 2 Exit Gate

- Minimized calls allocate no visual VAD analysers and present no hidden video frames.
- Remote audio and receiving tracks remain active.
- One diagnostics collection serves all consumers at policy cadence.
- Unchanged local tracks preserve stream and Zustand snapshot identities.
- Diagnostics updates do not rerender the call stage.
- Each task has a separately attributable benchmark delta.
