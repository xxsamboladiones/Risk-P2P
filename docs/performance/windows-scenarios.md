# Windows performance capture scenarios

This harness captures attribution data; it does not assert or imply a CPU or memory improvement. Run every comparison on the same Windows 10+ machine, release build, power plan, display setup, participant setup, and screen source.

## Capture setup

1. Build the release package with `pnpm build:desktop` and launch the packaged Windows application.
2. Record the Windows edition/build, Risk build version, CPU/GPU/RAM, power plan, display resolution and refresh rate, display scaling, participant count, network topology, and selected screen source in the capture notes.
3. Set `RISK_PERFORMANCE_REPORT_FILE` to an absolute, writable local JSON path, `RISK_PERFORMANCE_SCENARIO` to the scenario name below, and optionally `RISK_PERFORMANCE_DURATION_MS` (default: `60000`).
4. Prepare the named scenario completely. Do not include setup in the capture.
5. Press `CommandOrControl+Alt+Shift+F11` once. Maintain the prepared state for the fixed 60-second capture; do not interact unless the scenario specifies ordinary activity.
6. Repeat every scenario at least three times. Keep reports as local artifacts under `performance-results/pr1-baseline/`; do not commit them without explicit approval.
7. Compare like-for-like captures with `pnpm performance:report -- before.json after.json`. The command validates the versioned report schema and rejects scenario or duration mismatches.

Each report contains per-second Risk Browser/Tab process aggregates, a single renderer long-task/heap snapshot, and counters. A missing renderer response is recorded as a counter; it must be investigated, never presented as a performance result.

## Fixed scenarios

| Scenario value | Prepared state for the 60-second capture |
| --- | --- |
| `cold-start-restored-shell` | Start the packaged application from fully closed state and time usable restored authenticated shell separately; begin the fixed capture only once the shell is usable. |
| `foreground-idle-home` | Authenticated home surface visible and idle. |
| `hidden-idle-presence-notifications` | Hide the app to tray while presence and notifications remain enabled; generate no test traffic unless a controlled notification check is recorded separately. |
| `long-chat-history-attachments` | Open the same long chat history and attachment mix at the same scroll position. |
| `visible-audio-video-call` | Keep the same visible audio/video call with the documented participant count and cameras. |
| `minimized-call` | Start from the visible-call setup, then minimize the application while the call continues. |
| `screen-share-1080p30` | Publish the same documented 1080p/30 desktop source while performing ordinary, repeatable desktop activity. |
| `constrained-screen-share-30` | Use the documented constrained network/CPU condition and capture the observed 1080p/30 → 720p/30 → 480p/30 adaptation and recovery. This is a future-policy validation scenario; record current behavior unchanged for the PR 1 baseline. |
| `game-mode-screen-share-60` | Use the documented game source and constrained condition for the expected 1080p/60 → 720p/60 → 480p/60 → 480p/30 path and recovery. This is a future-policy validation scenario; record current behavior unchanged for the PR 1 baseline. |

Do not compare development-mode browser captures with packaged Electron captures. Do not claim a reduction unless comparable target-machine reports support it.
