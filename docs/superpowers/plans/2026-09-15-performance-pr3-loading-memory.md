# Performance PR 3: Loading and Retained Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce startup work and retained renderer memory by loading feature code/assets on demand, bounding mounted chat history, and releasing attachment/media resources deterministically.

**Architecture:** `RiskApplication` keeps a stable lazy call slot instead of eagerly importing `CallController`; React lazy boundaries defer feature UI. A measured virtual timeline bounds DOM nodes with variable-height measurement, while attachment preview and progress persistence are lifecycle-aware.

**Tech Stack:** TypeScript, React 19 `lazy`/`Suspense`, Vite 6 chunks, IndexedDB, ResizeObserver/IntersectionObserver, Vitest, PR-1 benchmark harness.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-windows-performance-design.md`

## Global Constraints

- Initial authenticated shell remains usable while deferred chunks load.
- Lazy loading must not instantiate duplicate call, chat, signaling, or storage controllers.
- Security boundaries and composition-root ownership remain unchanged.
- Virtualization preserves chronological order, replies, reactions, pins, gallery, attachments, edit/delete, and deterministic scroll anchoring.
- User-visible sends and transfer progress stay immediate; only redundant persistence writes may be coalesced.
- Visible styling and normal media quality remain unchanged.
- Preserve pre-existing uncommitted work; stage only task files.

---

## File Structure

- `apps/web/src/application/LazyCallRuntime.ts`: one-shot dynamic call-controller slot.
- `apps/web/src/components/LazyCallView.tsx`: resilient Suspense boundary.
- `apps/web/src/components/timeline-window.ts`: pure variable-height window calculation.
- `apps/web/src/components/VirtualConversationTimeline.tsx`: bounded DOM adapter.
- `apps/web/src/components/use-visible-preview.ts`: preview intersection lifecycle.
- `apps/web/src/services/attachments/progress-coalescer.ts`: latest intermediate persistence, immediate terminal flush.
- `scripts/verify-initial-chunks.mjs`: built-manifest assertion for eager/deferred modules.

### Task 1: Lazy call-controller slot

**Files:**
- Create: `apps/web/src/application/LazyCallRuntime.ts`
- Create: `apps/web/src/application/LazyCallRuntime.test.ts`
- Modify: `apps/web/src/application/RiskApplication.ts`
- Modify: `apps/web/src/application/runtime.ts`
- Modify: `apps/web/src/application/ApplicationContext.tsx`
- Modify: `apps/web/src/views/HomeView.tsx`
- Modify: `apps/web/src/views/CallView.tsx`

**Interfaces:**
- Consumes: async factory `() => Promise<CallController>` owned by the composition root.
- Produces: `LazyCallRuntime.load()`, `.getSnapshot()`, `.subscribe()`; `RiskApplication.calls` replaces eager `RiskApplication.call`.

- [ ] **Step 1: Write failing single-instance and retry tests**

```typescript
it("loads exactly one controller for concurrent callers", async () => {
  const factory = vi.fn(async () => controller);
  const slot = new LazyCallRuntime(factory);
  const [first, second] = await Promise.all([slot.load(), slot.load()]);
  expect(first).toBe(controller);
  expect(second).toBe(controller);
  expect(factory).toHaveBeenCalledOnce();
});

it("permits retry after a failed chunk load", async () => {
  const factory = vi.fn().mockRejectedValueOnce(new Error("chunk")).mockResolvedValueOnce(controller);
  const slot = new LazyCallRuntime(factory);
  await expect(slot.load()).rejects.toThrow("chunk");
  await expect(slot.load()).resolves.toBe(controller);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @risk/web test -- src/application/LazyCallRuntime.test.ts`

Expected: FAIL because the slot is absent.

- [ ] **Step 3: Implement the slot and dynamic composition factory**

```typescript
export class LazyCallRuntime {
  private value: CallController | null = null;
  private loading?: Promise<CallController>;
  private listeners = new Set<() => void>();
  constructor(private readonly factory: () => Promise<CallController>) {}
  readonly getSnapshot = () => this.value;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  async load(): Promise<CallController> {
    if (this.value) return this.value;
    this.loading ??= this.factory().then((value) => {
      this.value = value;
      this.listeners.forEach((listener) => listener());
      return value;
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }
}
```

In `runtime.ts`, use `new LazyCallRuntime(async () => { const { CallController } = await import("../call"); return new CallController(createSignaling, api); })`. In `HomeView`, await `application.calls.load()` only at join/toggle actions; existing active-room state guarantees the slot is loaded before mini call controls render. `CallView` reads the non-null snapshot and shows a bounded loading/error state if chunk resolution is still pending.

- [ ] **Step 4: Run application and call tests**

Run: `pnpm --filter @risk/web test -- src/application/LazyCallRuntime.test.ts src/application/ui-boundary.test.ts src/call.test.ts`

Expected: PASS; concurrent join actions cannot construct duplicate controllers.

- [ ] **Step 5: Commit lazy call runtime**

```bash
git add apps/web/src/application/LazyCallRuntime.ts apps/web/src/application/LazyCallRuntime.test.ts apps/web/src/application/RiskApplication.ts apps/web/src/application/runtime.ts apps/web/src/application/ApplicationContext.tsx apps/web/src/views/HomeView.tsx apps/web/src/views/CallView.tsx
git commit -m "perf(startup): defer call runtime creation"
```

### Task 2: React feature boundaries and chunk verification

**Files:**
- Create: `apps/web/src/components/LazyCallView.tsx`
- Create: `apps/web/src/components/LazyFeatureError.tsx`
- Create: `apps/web/src/components/lazy-feature.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/CallWorkspace.tsx`
- Create: `scripts/verify-initial-chunks.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: React `lazy`, `Suspense`, existing `AppErrorBoundary`, Vite output manifest.
- Produces: retryable call/game/gallery/settings boundaries and `pnpm verify:initial-chunks`.

- [ ] **Step 1: Write failing loader-eviction and build-graph tests**

```typescript
it("evicts a rejected feature import so retry can succeed", async () => {
  const importFeature = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ default: Feature });
  const loader = createRetryableFeatureLoader(importFeature);
  await expect(loader.load()).rejects.toThrow("network");
  await expect(loader.load()).resolves.toEqual({ default: Feature });
});
```

The Node verifier reads `apps/web/dist/.vite/manifest.json`, resolves the `src/main.tsx` static import closure, and fails if any eager module ID contains `/call/CallController`, `/call/game/`, `AttachmentGallery`, or `rnnoise`.

- [ ] **Step 2: Run the unit test and verify RED**

Run: `pnpm --filter @risk/web test -- src/components/lazy-feature.test.ts`

Expected: FAIL because the retryable loader is missing.

- [ ] **Step 3: Implement retryable Suspense boundaries**

```typescript
export function createRetryableFeatureLoader<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return {
    load: () => pending ??= load().catch((error) => { pending = undefined; throw error; }),
    reset: () => { pending = undefined; },
  };
}
```

Load `CallView`, `GameModeControls`, attachment gallery, and settings-only panels at their first visible boundary. Keep stable controllers outside lazy components. Enable `build.manifest: true` in Vite only if the verifier requires it, and add `verify:initial-chunks` to the root scripts.

- [ ] **Step 4: Build and verify chunks**

Run: `pnpm build:web`

Expected: Vite emits separate call, game, gallery/settings, and RNNoise chunks.

Run: `pnpm verify:initial-chunks`

Expected: exit 0 and print the eager byte total plus deferred chunk names.

- [ ] **Step 5: Commit boundaries and capture cold-start delta**

```bash
git add apps/web/src/components/LazyCallView.tsx apps/web/src/components/LazyFeatureError.tsx apps/web/src/components/lazy-feature.test.ts apps/web/src/App.tsx apps/web/src/components/CallWorkspace.tsx scripts/verify-initial-chunks.mjs package.json apps/web/vite.config.ts
git commit -m "perf(startup): split feature code from initial shell"
```

### Task 3: Pure variable-height timeline window

**Files:**
- Create: `apps/web/src/components/timeline-window.ts`
- Create: `apps/web/src/components/timeline-window.test.ts`

**Interfaces:**
- Consumes: ordered item IDs, measured height map, viewport offset/height, overscan pixels.
- Produces: `calculateTimelineWindow(input)` returning start/end indices, top/bottom spacer heights, and total height; `anchorAfterPrepend`.

- [ ] **Step 1: Write failing geometry and anchor tests**

```typescript
it("mounts only the visible variable-height range plus overscan", () => {
  const result = calculateTimelineWindow({
    ids: ["a", "b", "c", "d", "e"],
    heights: new Map([["a", 40], ["b", 80], ["c", 120], ["d", 60], ["e", 40]]),
    estimatedHeight: 64,
    scrollTop: 90,
    viewportHeight: 100,
    overscanPx: 20,
  });
  expect(result).toMatchObject({ start: 1, endExclusive: 3, topSpacerPx: 40, bottomSpacerPx: 100 });
});

it("preserves the first visible item after older rows are prepended", () => {
  expect(anchorAfterPrepend({ anchorId: "c", anchorOffsetPx: 12 }, ["a", "b", "c", "d"]))
    .toEqual({ anchorId: "c", anchorOffsetPx: 12, index: 2 });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @risk/web test -- src/components/timeline-window.test.ts`

Expected: FAIL because the geometry module is absent.

- [ ] **Step 3: Implement prefix-sum window selection**

Use measured height when available and `estimatedHeight` otherwise. Build prefix sums, binary-search the first row ending after `scrollTop - overscanPx`, binary-search the first row starting after `scrollTop + viewportHeight + overscanPx`, and calculate spacers from the prefix array. Clamp all indices and treat an empty list as zero-height.

```typescript
export type TimelineWindow = { start: number; endExclusive: number; topSpacerPx: number; bottomSpacerPx: number; totalHeightPx: number };
export function calculateTimelineWindow(input: TimelineWindowInput): TimelineWindow;
export function anchorAfterPrepend(anchor: TimelineAnchor, ids: readonly string[]): TimelineAnchor & { index: number };
```

- [ ] **Step 4: Run randomized invariant tests**

Add a deterministic seeded test over 200 generated height/viewport cases asserting `0 <= start <= endExclusive <= ids.length`, non-negative spacers, and `top + mounted + bottom === total`.

Run: `pnpm --filter @risk/web test -- src/components/timeline-window.test.ts`

Expected: PASS for fixed and generated cases.

- [ ] **Step 5: Commit the pure engine**

```bash
git add apps/web/src/components/timeline-window.ts apps/web/src/components/timeline-window.test.ts
git commit -m "feat(chat): add measured timeline window engine"
```

### Task 4: Virtual conversation timeline adapter

**Files:**
- Create: `apps/web/src/components/VirtualConversationTimeline.tsx`
- Create: `apps/web/src/components/virtual-timeline-model.ts`
- Create: `apps/web/src/components/virtual-timeline-model.test.ts`
- Modify: `apps/web/src/components/ConversationTimeline.tsx`
- Modify: `apps/web/src/views/HomeView.tsx`
- Modify: `apps/web/src/components/CallWorkspace.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/components/call-workspace.css`

**Interfaces:**
- Consumes: `calculateTimelineWindow`, merged message/attachment items, parent scroll element.
- Produces: at most the visible rows plus 600 px overscan mounted; `scrollToItem(id)` for pin/reply navigation.

- [ ] **Step 1: Write failing merge/order/window model tests**

```typescript
it("keeps stable IDs and chronological order for mixed rows", () => {
  expect(buildTimelineRows(messages, attachments).map((row) => row.id)).toEqual([
    "message:m1", "attachment:a1", "message:m2",
  ]);
});

it("returns a bounded mounted slice for ten thousand rows", () => {
  const model = virtualTimelineModel(tenThousandRows, measurements, { scrollTop: 200_000, viewportHeight: 700 });
  expect(model.rows.length).toBeLessThan(80);
});
```

- [ ] **Step 2: Run the model test and verify RED**

Run: `pnpm --filter @risk/web test -- src/components/virtual-timeline-model.test.ts`

Expected: FAIL because the model is absent.

- [ ] **Step 3: Implement measured rows and scroll anchoring**

`VirtualConversationTimeline` listens passively to the existing `.messages` scroller, observes its size, measures mounted rows with one shared `ResizeObserver`, and renders top spacer, the bounded row slice, and bottom spacer. On prepend, capture the first visible row ID/offset before state commit and restore it in `useLayoutEffect`. `scrollToItem` first calculates the estimated offset, scrolls, then corrects after measurement. Move existing row markup into a keyed `ConversationRow` without changing actions or accessibility.

```tsx
<div style={{ height: window.topSpacerPx }} aria-hidden="true" />
{window.rows.map((row) => <MeasuredConversationRow key={row.id} row={row} onHeight={recordHeight} />)}
<div style={{ height: window.bottomSpacerPx }} aria-hidden="true" />
```

- [ ] **Step 4: Run history behavior and build verification**

Run: `pnpm --filter @risk/web test -- src/components/timeline-window.test.ts src/components/virtual-timeline-model.test.ts src/chat/HistoryService.test.ts`

Expected: PASS; 10,000-row fixture mounts fewer than 80 rows at the specified viewport.

Run: `pnpm build:web`

Expected: exit 0 with no accessibility/type errors.

- [ ] **Step 5: Commit and capture long-chat memory**

```bash
git add apps/web/src/components/VirtualConversationTimeline.tsx apps/web/src/components/virtual-timeline-model.ts apps/web/src/components/virtual-timeline-model.test.ts apps/web/src/components/ConversationTimeline.tsx apps/web/src/views/HomeView.tsx apps/web/src/components/CallWorkspace.tsx apps/web/src/styles.css apps/web/src/components/call-workspace.css
git commit -m "perf(chat): virtualize long conversation timelines"
```

### Task 5: Visible attachment previews and lazy gallery

**Files:**
- Create: `apps/web/src/components/use-visible-preview.ts`
- Create: `apps/web/src/components/use-visible-preview.test.ts`
- Create: `apps/web/src/components/AttachmentGallery.tsx`
- Modify: `apps/web/src/components/AttachmentCard.tsx`
- Modify: `apps/web/src/components/ConversationTimeline.tsx`

**Interfaces:**
- Consumes: `IntersectionObserver`, `AttachmentCard.loadBlob`.
- Produces: preview loading only within 400 px of viewport; immediate object-URL revocation on invisibility/unmount; lazy gallery chunk.

- [ ] **Step 1: Write failing preview resource tests**

```typescript
it("loads once on near-viewport entry and revokes on exit", async () => {
  const lifecycle = new VisiblePreviewLifecycle(loadBlob, createObjectURL, revokeObjectURL);
  await lifecycle.setVisible(true);
  await lifecycle.setVisible(true);
  expect(loadBlob).toHaveBeenCalledOnce();
  lifecycle.setVisible(false);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @risk/web test -- src/components/use-visible-preview.test.ts`

Expected: FAIL because the lifecycle is absent.

- [ ] **Step 3: Implement intersection-driven preview ownership**

Create one observer per card with `rootMargin: "400px"`. The lifecycle owns exactly one URL, ignores stale blob promises by generation, revokes on exit/unmount, and never auto-loads executable/document/archive bodies. Extract gallery markup to `AttachmentGallery.tsx` and load it with the retryable feature loader only when opened.

```typescript
const generation = ++this.generation;
const blob = await this.loadBlob();
if (!this.visible || generation !== this.generation) return;
this.url = URL.createObjectURL(blob);
```

- [ ] **Step 4: Run attachment and chunk tests**

Run: `pnpm --filter @risk/web test -- src/components/use-visible-preview.test.ts src/services/attachments/attachment-service.test.ts`

Expected: PASS with no leaked URL after exit/unmount.

Run: `pnpm build:web`

Expected: gallery appears in a deferred chunk.

- [ ] **Step 5: Commit preview lifecycle**

```bash
git add apps/web/src/components/use-visible-preview.ts apps/web/src/components/use-visible-preview.test.ts apps/web/src/components/AttachmentGallery.tsx apps/web/src/components/AttachmentCard.tsx apps/web/src/components/ConversationTimeline.tsx
git commit -m "perf(attachments): load previews only near viewport"
```

### Task 6: Coalesced progress persistence and deferred call sounds

**Files:**
- Create: `apps/web/src/services/attachments/progress-coalescer.ts`
- Create: `apps/web/src/services/attachments/progress-coalescer.test.ts`
- Modify: `apps/web/src/services/attachments/attachment-service.ts`
- Modify: `apps/web/src/services/attachments/attachment-service.test.ts`
- Modify: `apps/web/src/services/audio/call-sounds.ts`
- Modify: `apps/web/src/services/audio/call-sounds.test.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: progress events and 250 ms persistence cadence; actual call sound playback.
- Produces: immediate in-memory UI progress, latest-only intermediate durable writes, immediate terminal flush, no sound fetch/decode at startup.

- [ ] **Step 1: Write failing coalescing and sound-startup tests**

```typescript
it("persists only the latest intermediate sample and flushes terminal state immediately", async () => {
  const save = vi.fn(async () => undefined);
  const coalescer = new ProgressCoalescer(save, 250);
  coalescer.push(progress(100, "transferring"));
  coalescer.push(progress(200, "transferring"));
  await vi.advanceTimersByTimeAsync(250);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenLastCalledWith(progress(200, "transferring"));
  await coalescer.push(progress(300, "completed"));
  expect(save).toHaveBeenCalledTimes(2);
});

it("does not construct Audio elements during App startup", () => {
  preloadCallSounds();
  expect(Audio).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @risk/web test -- src/services/attachments/progress-coalescer.test.ts src/services/audio/call-sounds.test.ts`

Expected: FAIL because progress is persisted for every event and startup preloading constructs audio.

- [ ] **Step 3: Separate UI emission from durable progress and defer sounds**

Dispatch speed/progress to UI synchronously from each event. Pass the latest intermediate record to `ProgressCoalescer`; states `completed`, `failed`, `cancelled`, `paused`, and `verifying` flush pending data before immediate persistence. Await `flush(transferId)` before cancel/download/checkpoint operations. Remove `preloadCallSounds()` from `App` startup; call a renamed `warmCallSounds()` only after join intent or let `playCallSound` create the fallback lazily.

```typescript
const TERMINAL_OR_CHECKPOINT = new Set(["completed", "failed", "cancelled", "paused", "verifying"]);
if (TERMINAL_OR_CHECKPOINT.has(progress.state)) await coalescer.flushNow(progress);
else coalescer.push(progress);
```

- [ ] **Step 4: Run attachment/audio suites and complete PR verification**

Run separately:

- `pnpm --filter @risk/web test`
- `pnpm typecheck`
- `pnpm build:web`
- `pnpm verify:initial-chunks`

Expected: all exit 0; attachment acknowledgements and terminal states remain durable.

- [ ] **Step 5: Commit and record cold-start/long-chat deltas**

```bash
git add apps/web/src/services/attachments/progress-coalescer.ts apps/web/src/services/attachments/progress-coalescer.test.ts apps/web/src/services/attachments/attachment-service.ts apps/web/src/services/attachments/attachment-service.test.ts apps/web/src/services/audio/call-sounds.ts apps/web/src/services/audio/call-sounds.test.ts apps/web/src/App.tsx
git commit -m "perf(runtime): coalesce persistence and defer call assets"
```

### Task 7: Lazy attachment processing runtime

**Files:**
- Create: `apps/web/src/chat/LazyAttachmentService.ts`
- Create: `apps/web/src/chat/LazyAttachmentService.test.ts`
- Modify: `apps/web/src/chat/ChatController.ts`
- Modify: `apps/web/src/chat/AttachmentService.ts`
- Modify: `scripts/verify-initial-chunks.mjs`

**Interfaces:**
- Consumes: deferred factory `() => import("./AttachmentService")`, stored connection arguments, and the PR-1 activity registry.
- Produces: the existing attachment facade methods without importing storage, hashing, sender, or receiver code before first attachment history/send/request/control/transfer use.

- [ ] **Step 1: Write failing lazy construction and remote-offer tests**

```typescript
it("does not load attachment processing when ordinary chat connects", async () => {
  const load = vi.fn(async () => new ChatAttachmentService(activity));
  const lazy = new LazyAttachmentService(load);
  lazy.bind(connectionArguments);
  expect(load).not.toHaveBeenCalled();
});

it("loads once when the first attachment control message arrives", async () => {
  const load = vi.fn(async () => service);
  const lazy = new LazyAttachmentService(load);
  lazy.bind(connectionArguments);
  await lazy.handleControl("peer", JSON.stringify({ type: "file.offer", transferId: "t1" }));
  expect(load).toHaveBeenCalledOnce();
  expect(service.connect).toHaveBeenCalledWith(...connectionArguments);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @risk/web test -- src/chat/LazyAttachmentService.test.ts`

Expected: FAIL because the lazy facade is absent.

- [ ] **Step 3: Implement one-shot deferred connection**

Store the latest connection arguments without constructing the heavy service. `ensure()` imports once, constructs with the shared activity registry, connects using the stored generation, and evicts a rejected import for retry. `handleControl` performs a bounded JSON envelope check for `file.`, `attachment.`, `sync.attachment.`, or peer capability messages before loading; ordinary chat messages return `false`. `clear()` invalidates the generation and disconnects/releases any loaded service.

```typescript
private async ensure(): Promise<ChatAttachmentService> {
  if (this.value) return this.value;
  const generation = this.generation;
  this.loading ??= this.load().then(async (service) => {
    if (generation !== this.generation || !this.connection) throw new DOMException("Sessão substituída", "AbortError");
    await service.connect(...this.connection);
    this.value = service;
    return service;
  }).finally(() => { this.loading = undefined; });
  return this.loading;
}
```

- [ ] **Step 4: Run chat/attachment suites and eager-graph verification**

Run: `pnpm --filter @risk/web test -- src/chat/LazyAttachmentService.test.ts src/chat-controller.test.ts src/chat/AttachmentService.test.ts`

Expected: PASS; first remote offer is handled and ordinary chat does not import attachment processing.

Run: `pnpm build:web`

Expected: exit 0.

Run: `pnpm verify:initial-chunks`

Expected: eager closure contains neither `/services/attachments/attachment-service` nor streaming hash/file-transfer implementation modules.

- [ ] **Step 5: Commit the lazy attachment runtime**

```bash
git add apps/web/src/chat/LazyAttachmentService.ts apps/web/src/chat/LazyAttachmentService.test.ts apps/web/src/chat/ChatController.ts apps/web/src/chat/AttachmentService.ts scripts/verify-initial-chunks.mjs
git commit -m "perf(startup): defer attachment processing runtime"
```

## PR 3 Exit Gate

- Eager import closure excludes call controller, game helpers, attachment processing, gallery/settings UI, and RNNoise.
- Concurrent first use constructs exactly one call controller.
- A 10,000-row conversation mounts fewer than 80 rows at a 700 px viewport.
- Reply/pin navigation and prepend anchoring remain deterministic.
- Attachment URLs are absent outside the near-viewport range and revoked on exit.
- User-visible progress remains immediate; terminal persistence remains immediate/durable.
- Cold-start and long-chat memory reports are attributable to this PR.
