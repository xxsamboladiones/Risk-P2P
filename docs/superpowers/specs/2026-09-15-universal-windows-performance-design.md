# Universal Windows Performance Design

**Date:** 2026-09-15

**Status:** Approved design with review amendments

**Primary platform:** Windows 10 and newer

**Target class:** Third-generation Intel Core i3 systems with integrated graphics, while screen sharing and performing ordinary desktop work

## Objective

Reduce CPU use, retained memory, main-thread contention, startup work, background activity, and unnecessary media processing across the entire Risk desktop application without removing features or perceptibly degrading the current interface and normal media quality.

Screen-share quality remains at the selected or current profile while the machine has capacity. Under confirmed sustained overload, the adaptive floor is 854x480 at 30 frames per second. The system must never adapt below 480p/30.

## Scope

The work covers the complete Windows desktop runtime:

- Electron startup, process lifecycle, renderer visibility, GPU use, and packaged behavior;
- React rendering, state subscriptions, large views, animation, and hidden UI;
- application startup and on-demand loading of feature code and assets;
- chat history rendering, persistence, attachments, and background synchronization;
- voice activity analysis, microphone processing, camera, remote playback, and local previews;
- WebRTC statistics, mesh transport work, publication parameters, and screen sharing;
- game mode where its work overlaps the general runtime and media pipeline;
- repeatable performance measurement and regression gates.

The work does not change the product's visual design, messaging semantics, encryption/authentication model, delivery guarantees, supported call features, or network topology. Windows 7 and Windows 8.1 are not supported targets.

## Current Evidence

Initial source inspection found several structural costs that justify a coordinated solution:

- screen sharing currently initializes at 1080p/30 by default;
- live call diagnostics poll every three seconds while the call workspace is mounted;
- voice activity samples every 50 milliseconds for each observed live audio stream;
- the Electron window sets `backgroundThrottling: false` for its entire lifetime;
- a minimized call remains mounted and continues visual work even when its layer is hidden;
- the current built renderer has no production route or feature-level lazy imports beyond the optional RNNoise module;
- the existing main application chunk is approximately 462 KB uncompressed, in addition to separate React and Supabase chunks;
- large responsibilities are concentrated in `HomeView`, `CallWorkspace`, `CallController`, `MediaManager`, `ChatController`, `social-storage`, and the Mesh transport;
- local previews create new `MediaStream` wrapper objects during media-state updates;
- screen, game, GPU, and call files already contain uncommitted user work that must be preserved.

These observations are hypotheses about optimization opportunities, not proof of their individual CPU or memory impact. The implementation begins by recording a reproducible baseline and uses profiles to decide which changes are retained.

## Chosen Approach

Use a universal adaptive performance architecture. A small central coordinator converts inexpensive runtime signals into a stable execution policy. Subsystems consume the policy relevant to them instead of independently polling hardware or inventing local heuristics.

An aggressive module rewrite is permitted only when profiling demonstrates that an isolated module accounts for at least 25 percent of renderer main-thread self time or retained heap in the affected benchmark, and bounded improvements cannot bring it within budget. A rewrite must preserve the module's public interface and pass equivalence tests. There is no authorization for an application-wide rewrite.

## Runtime States

Lifecycle and media pressure are separate axes because a constrained call can be either visible or hidden. The coordinator exposes semantic values rather than raw device details:

- `foreground`: the app is visible and interactive; normal quality and responsiveness take priority.
- `foreground-call`: the call workspace is visible; media, diagnostics, and visible presentation remain active.
- `background-call`: a call continues while its workspace or window is hidden; audio, signaling, publication, and required recovery remain active, while invisible presentation work is suspended.
- `idle-hidden`: the application window is hidden and no call workspace requires presentation; renderer UI work and non-urgent polling are paused or heavily coalesced while presence, messaging, and notifications remain functional. Background activities independently retain the scheduling permissions they require.

Media pressure is an independent deterministic state:

```typescript
type ExecutionMode = "foreground" | "foreground-call" | "background-call" | "idle-hidden";
type MediaPressure = "normal" | "warning" | "overloaded";

type RuntimeActivity = {
  callActive: boolean;
  transferActive: boolean;
  screenPublicationActive: boolean;
  gameSessionActive: boolean;
};
```

`mediaPressure: "overloaded"` means sustained measurements show that the machine cannot maintain the current publication profile. Adaptive media policy may reduce the screen profile but no lower than 480p/30.

`RuntimeActivity` does not create additional execution modes. The policy derives `hasCriticalBackgroundWork` from these flags. A hidden window remains `idle-hidden` when a transfer is active, but the resulting policy denies Chromium background throttling and preserves transfer/backpressure scheduling. This avoids combinatorial modes such as `background-transfer`, `background-game`, or `background-call-transfer`.

Returning to a more active state is event-driven. Deferred work is coalesced so focus restoration does not cause a burst of expired timers or repeated state refreshes.

## Performance Coordinator

The coordinator lives in a focused renderer runtime module and has a pure policy core. It receives:

- Electron window visibility and safe, aggregated metrics for Risk's own processes;
- document visibility and the currently active application surface;
- whether a call, file transfer, screen share, or game session is active;
- WebRTC encode time, outbound capacity, dropped-frame data when available, and network diagnostics;
- renderer responsiveness signals such as sustained event-loop delay or long tasks when the Chromium API provides them.

The Electron bridge exposes only aggregated values needed by the policy and never exposes arbitrary process inspection. Expensive metrics are sampled only while a scenario can use them, and all observers and timers have explicit cleanup.

The coordinator emits a small immutable policy containing cadences and permissions such as whether hidden video presentation, visual voice activity, diagnostics, and non-urgent synchronization should run. Consumers must not depend on threshold details.

### Policy ownership

The coordinator is a pure policy engine. It owns signal normalization, counters, hysteresis, cooldowns, and the derivation of `PerformancePolicy`. It does not own or call feature implementations.

It may produce decisions such as:

```typescript
{
  mode: "background-call",
  mediaPressure: "warning",
  visualVoiceActivityEnabled: false,
  hiddenVideoPresentationEnabled: false,
  diagnosticsIntervalMs: 10_000,
  chromiumBackgroundThrottlingAllowed: false,
  effectiveScreenProfile: "720p30"
}
```

It must never call `mesh.getStats()`, change a media track, stop a video element, mutate React state, invoke `CallController`, or control an Electron window directly. Mesh, media, React, and Electron adapters observe the policy and execute only their own responsibilities. This dependency direction prevents the coordinator from becoming another application controller.

If a signal or browser API is unavailable, the policy remains at the normal-quality state. Measurement failure never stops a call, restarts a transmission, or silently disables a feature.

## Stability and Hysteresis

Media adaptation requires sustained evidence rather than a single slow frame or network sample. The pure state distinguishes user intent from the profile currently required by runtime conditions:

```typescript
type ScreenProfile =
  | "480p30"
  | "720p30"
  | "1080p30"
  | "480p60"
  | "720p60"
  | "1080p60";

type AdaptiveMediaState = {
  requestedProfile: ScreenProfile;
  effectiveProfile: ScreenProfile;
  overloadSamples: number;
  recoverySamples: number;
  lastTransitionAt: number | null;
  cooldownUntil: number | null;
};
```

`requestedProfile` is the maximum recovery ceiling selected by the user or game-mode policy. `effectiveProfile` is the currently applied profile. Recovery may climb only toward `requestedProfile` and must stop there; it can never silently upgrade to a profile the user did not request. Missing samples preserve both profiles and cannot independently trigger a transition.

The initial deterministic cadence is one aggregate sample every two seconds while screen publication is active:

- two consecutive bad samples move pressure from `normal` to `warning` without changing profile;
- four consecutive bad samples move pressure to `overloaded` and reduce exactly one profile rung;
- fifteen consecutive healthy samples permit recovery by exactly one profile rung;
- every profile change starts a twenty-second cooldown during which no further profile change occurs;
- a healthy sample before overload resets `overloadSamples`, while a bad sample during recovery resets `recoverySamples`.

Sampling and pressure classification continue during cooldown. Cooldown blocks publication-profile transitions, not signal collection, counter updates, or pressure-state updates. When cooldown ends, the already accumulated classification determines whether the next permitted transition reduces, holds, or recovers one rung.

Benchmark evidence may tune the counts, cadence, and cooldown before release, but their named state and one-rung transition model remain part of the architecture and test contract.

Adaptation follows the current profile's frame-rate family:

- ordinary 30 FPS sharing: 1080p/30 to 720p/30 to 480p/30;
- an explicitly selected 720p/30 profile may reduce only to 480p/30;
- game mode and explicitly selected 60 FPS sharing use the exact ladder 1080p/60 to 720p/60 to 480p/60 to 480p/30;
- camera adaptation remains governed by existing WebRTC behavior unless profiling identifies it as a material bottleneck.

The last valid publication profile remains active if applying a new profile fails. Failures are logged in diagnostics without interrupting media.

## Renderer and React Design

Large views are split along existing responsibility boundaries, not by arbitrary file size. The initial candidates are `HomeView` and `CallWorkspace`; extraction proceeds only where profiling or render-count instrumentation shows useful isolation.

The renderer changes follow these rules:

- components subscribe only to the state fields they render;
- periodic diagnostic state is isolated from the video grid and chat timeline;
- derived arrays and media identities remain stable when their inputs have not changed;
- media preview wrappers are reused instead of recreated for unrelated state notifications;
- hidden call panels do not keep video elements painting or voice indicators sampling;
- long histories mount a bounded visible window with stable scroll anchoring, while search, reply, reactions, pins, attachments, and chronological ordering keep existing semantics;
- visual animations and expensive blur/shadow effects are suspended only while their surface is invisible or the user requests reduced motion; visible appearance remains unchanged;
- focus restoration refreshes stale state once rather than replaying background updates.

## Loading and Startup

The authenticated shell remains eager. Feature-heavy code is loaded at the point the user enters the feature, with resilient loading boundaries for:

- call workspace and call-only controllers;
- game-mode controls and capture/input helpers;
- attachment gallery and heavy attachment processing;
- settings surfaces not needed for the initial route;
- RNNoise, which already uses a dynamic module import and must remain optional.

Call sounds are not fetched or decoded during initial application restoration unless measurement shows preloading to be free. The first actual call interaction may warm the assets, and playback retains the existing fallback behavior.

Lazy loading must not alter security boundaries or instantiate duplicate application controllers. The composition root continues to own concrete adapters.

## Background Lifecycle

Electron no longer applies an unconditional lifetime-wide background policy. The runtime chooses background behavior according to active work:

- idle hidden windows permit Chromium throttling;
- active calls, transfers, or screen publication retain the scheduling needed for correctness;
- renderer consumers still suspend invisible presentation work even when media requires the renderer to remain schedulable;
- native WebRTC capture, encode, signaling, and audio are never paused merely because their React surface is hidden;
- tray presence and message notifications continue in every applicable state.

The packaged Windows application must be tested because browser development mode does not reproduce Electron background scheduling, process metrics, GPU selection, or desktop capture.

## Media and WebRTC Work

The call pipeline separates required transport work from optional presentation and diagnostics. Voice activity has two explicit roles:

- semantic VAD is an application-level signal that may drive active-speaker selection, prioritization, statistics, accessibility, or future call logic;
- visual VAD exists only to render speaking borders and animations.

Current code uses VAD only for visual speaking classes, but the interface preserves the distinction. `visualVoiceActivityEnabled: false` stops analyzers created only for presentation. It must not disable a present or future semantic VAD consumer.

The remaining media rules are:

- WebRTC statistics collection uses a shared cadence and a single sample per peer per interval;
- diagnostics views consume cached summaries instead of triggering their own collections;
- inactive or closed calls perform no periodic stats collection;
- visual voice activity runs only for audible, presented participants and stops for hidden tiles;
- remote video elements that cannot be seen stop presentation work while the peer connection, receiving tracks, and remote audio remain active;
- local camera and screen previews detach or pause when hidden while publication continues;
- publication parameter updates are deduplicated and applied only when the requested effective profile changes;
- Mesh adaptation uses already collected summaries rather than repeating `getStats()` calls;
- file transfer backpressure and call recovery retain existing correctness and timing guarantees.

The policy specifies the hidden-video outcome, not a DOM mechanism. The React/media adapter chooses whether to pause presentation, detach only a video-only stream, or use another browser-supported mechanism. It must not detach a combined stream in a way that interrupts audio, and tests assert continued audio/track/connection behavior rather than requiring a particular `HTMLVideoElement` implementation.

## Chat and Persistence

Chat optimization preserves durable and observable behavior:

- database and IndexedDB writes may be batched only where acknowledgements and crash semantics remain equivalent;
- background synchronization coalesces redundant refreshes but does not delay user-visible sends;
- large timelines render a bounded window and retain deterministic scroll restoration;
- attachment decoding, thumbnails, and object URLs are created on demand and released when no longer presented;
- hiding the app may lower non-urgent maintenance cadence but cannot suppress incoming-message notifications or delivery processing.

## Windows and GPU Policy

Hardware acceleration remains enabled by default on Windows 10 and newer. Third-generation Intel systems may still provide useful decode, composition, or H.264 acceleration, so CPU age alone is not grounds for disabling the GPU.

The runtime distinguishes a healthy GPU path from a failed or repeatedly crashing path using Electron/Chromium evidence. Software fallback is allowed only after a real failure or an explicit environment override. Existing capture compatibility switches and current uncommitted game-capture work remain intact.

No optimization may weaken context isolation, sandboxing, origin validation, permission handling, or the authenticated loopback bridge.

## Measurement and Acceptance

The implementation adds a repeatable benchmark harness with comparable scenarios:

1. cold start through restored authenticated shell;
2. foreground idle on the home surface;
3. hidden idle with presence and notifications enabled;
4. a long chat history with attachments;
5. a visible audio/video call;
6. a minimized call;
7. screen publication at 1080p/30 with ordinary desktop activity;
8. constrained screen publication demonstrating 1080p/30 to 720p/30 to 480p/30 adaptation and recovery;
9. game mode demonstrating 1080p/60 to 720p/60 to 480p/60 to 480p/30 adaptation and recovery.

The harness records, where supported:

- time to usable shell and initial eager bundle bytes;
- renderer and application-process CPU samples;
- renderer heap and application working set;
- long-task count and duration, event-loop delay, and render counts at targeted boundaries;
- active intervals/observers owned by Risk in each lifecycle state;
- WebRTC stats collection count, encode time, bitrate, frames encoded/dropped, and effective capture constraints;
- functional outcomes for messages, notifications, audio, camera, screen share, recovery, and transfers.

Acceptance is based on these invariants:

- hidden idle performs no periodic UI, visual voice-activity, or call-diagnostic work, while active transfers and publications retain their required scheduling;
- no call means no periodic WebRTC statistics collection;
- minimized calls retain required transport/audio behavior while invisible video presentation and voice visualization stop;
- initial feature code excludes call, game, attachment-gallery, and RNNoise implementations until needed;
- the adaptive screen-share policy never selects less than 854x480 at 30 FPS, and 60 FPS sharing follows the defined four-rung ladder;
- normal visible quality and styling remain unchanged when the machine is not constrained;
- all existing functional test suites and packaged Windows verification pass;
- before/after reports use the same build type, scenario script, duration, and machine, and do not claim a CPU or memory improvement without measured evidence.

Numerical CPU and memory reduction percentages are reported from the target Windows machine rather than invented as cross-machine guarantees. Any scenario that regresses its primary CPU or memory metric is investigated before the related change is retained.

## Test Strategy

Implementation uses test-driven development. Each behavior is introduced by a failing test and verified independently before integration.

- Pure policy tests cover lifecycle, runtime activity, and pressure as independent inputs; hidden active transfers; missing metrics; warning state; consecutive overload samples; cooldown classification; one-rung transitions; requested/effective profile ceilings; recovery; the exact 60 FPS ladder; and the 480p/30 floor.
- Lifecycle tests cover visibility changes, minimized workspace behavior, active calls, transfers, screen publication, game sessions, cleanup, and focus restoration.
- React tests prove that diagnostic updates do not rerender unrelated grids/timelines, hidden media presentation stops, visual VAD stops, and any semantic VAD consumer remains active.
- Loading tests verify that feature modules are absent from the eager graph and load successfully at their boundaries.
- RTC tests count stats calls, parameter changes, and track continuity during adaptation.
- Chat tests cover long-history windowing, scroll anchoring, message ordering, replies, reactions, pins, and attachment cleanup.
- Electron tests cover policy IPC validation and dynamic background behavior.
- Packaged Windows smoke tests exercise startup, tray hiding/restoration, background calls, capture, and renderer recovery.

Performance tests supplement functional tests; they do not replace them.

## Delivery Sequence

Implementation is divided into four independently measurable integration units. Each unit records its own before/after report so later gains are attributable rather than combined into one unexplained result.

### PR 1: Measurement and lifecycle

- add benchmark primitives and capture the reproducible baseline without changing behavior;
- add the pure coordinator, independent execution/pressure state, and policy ownership boundary;
- connect document and Electron visibility plus orthogonal runtime-activity signals;
- implement `background-call` and `idle-hidden` lifecycle decisions;
- verify packaged Windows minimize, tray, restore, notification, call, and transfer behavior.

### PR 2: Low-risk hot-path reductions

- split visual VAD from the semantic contract and suspend only visual analysis;
- consolidate `getStats()` collection and expose cached summaries;
- suspend hidden video presentation and local previews while publication continues;
- reuse stable `MediaStream` wrappers and deduplicate media parameter updates;
- narrow React subscriptions and isolate diagnostics from grids and timelines;
- measure each change group independently inside the PR benchmark report.

### PR 3: Loading and retained memory

- introduce call, game, attachment-gallery, settings, and optional processing lazy boundaries;
- split `CallWorkspace` and `HomeView` only where profiling proves a render or retention boundary;
- virtualize long chat histories with stable anchoring;
- load/decode attachments and call assets on demand and release them deterministically;
- optimize non-urgent persistence batching only where acknowledgement and crash semantics remain equivalent.

### PR 4: Adaptive media and Windows runtime

- implement `MediaPressure`, counters, hysteresis, cooldown, and one-rung transitions;
- add 480p/30 and 480p/60 profiles and the exact 30 FPS and 60 FPS ladders;
- connect cached WebRTC/encode pressure without duplicating stats collection;
- apply dynamic Electron background behavior and evidence-based GPU fallback;
- run complete functional, packaged, and target-machine comparisons;
- profile remaining bottlenecks and use an isolated approach-3 replacement only when the 25 percent criterion is met.

Each PR is independently reviewable and must preserve the user's existing uncommitted changes. Commits stage only files belonging to the performance work. A later PR cannot claim gains measured only after combining unrelated later changes.

## Risks and Mitigations

- **Background calls lose events:** keep transport/signaling work separate from presentation suspension and test packaged minimize/restore flows.
- **Quality oscillates:** require consecutive evidence, recovery windows, and cooldowns.
- **Lazy loading delays first use:** preload only after the shell is interactive or at clear user intent, with visible error recovery.
- **Virtualized history jumps:** preserve anchor identity and test prepend, append, reply navigation, and attachment resizing.
- **GPU fallback increases CPU:** retain acceleration by default and fall back only on observed failure.
- **Instrumentation becomes overhead:** sample only in relevant states, aggregate data, and remove development-only detail from the production hot path.
- **Existing work is overwritten:** inspect diffs before every edit and stage performance files explicitly.

## Completion Criteria

The project is complete when all delivery steps are implemented, all functional and packaged Windows checks pass, the target-machine report covers every benchmark scenario, normal visible quality is preserved, constrained screen sharing respects the 480p/30 floor, and no retained optimization produces a measured regression in its primary scenario.
