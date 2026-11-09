# Chat Image Paste and Transfer Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage pasted and selected images for confirmation in every chat composer and prevent attachment transfers from stalling while a WebRTC transfer channel drains.

**Architecture:** Keep pending-file UI state inside the shared `MessageComposer`, so private, group, and in-call chats receive identical behavior without changing their controllers. Keep attachment transport flow control inside `MeshWebRTCTransport`, using an event plus a condition recheck and short polling fallback so a missed `bufferedamountlow` event cannot suspend a transfer until timeout.

**Tech Stack:** React 19, TypeScript, Web Clipboard/DataTransfer APIs, WebRTC RTCDataChannel, Vitest.

**Spec:** Approved conversation design on 2026-09-14: pasted and selected images show removable previews and are sent only after pressing send; multiple images are supported; ordinary text paste remains unchanged.

## Global Constraints

- Preserve the existing P2P attachment validation, persistence, and transfer protocol.
- Apply composer behavior to private, group, and in-call chats through the shared component.
- Revoke every temporary object URL after removal, successful submission, or unmount.
- Do not alter unrelated dirty game-mode and desktop files.

---

### Task 1: Pending attachment model and clipboard extraction

**Files:**
- Create: `apps/web/src/components/message-composer-attachments.ts`
- Test: `apps/web/src/components/message-composer-attachments.test.ts`

**Interfaces:**
- Produces: `clipboardImageFiles(items)`, `createPendingAttachments(files, createObjectUrl)`, and `revokePendingAttachments(items, revokeObjectUrl)`.

- [x] **Step 1: Write failing tests** for extracting only clipboard images, retaining selected non-image files without image previews, generating stable pending IDs, and revoking preview URLs.
- [x] **Step 2: Run the focused Vitest file** and verify failure because the helper module does not exist.
- [x] **Step 3: Implement the minimal pure helpers** with unnamed clipboard-image filenames derived from MIME type.
- [x] **Step 4: Run the focused test** and verify it passes.

### Task 2: Confirm-before-send composer UI

**Files:**
- Modify: `apps/web/src/components/MessageComposer.tsx`
- Modify: `apps/web/src/components/attachments.css`
- Test: `apps/web/src/components/message-composer-attachments.test.ts`

**Interfaces:**
- Consumes: the pending attachment helpers from Task 1 and the existing `onFiles(files: File[])` callback.
- Produces: pasted/selected/dropped files queued until form submission, removable preview cards, and one submit operation that sends queued files only after confirmation.

- [x] **Step 1: Add failing state-transition tests** proving removal excludes a file and successful consumption clears all pending files.
- [x] **Step 2: Run the focused test** and verify the new assertions fail.
- [x] **Step 3: Add `onPaste`, pending previews, removal, and submit orchestration** to `MessageComposer`; preserve ordinary pasted text and keep pending files after a failed send.
- [x] **Step 4: Add responsive preview styling** without changing the surrounding chat layouts.
- [x] **Step 5: Run web tests and typecheck** and verify they pass.

### Task 3: Race-free WebRTC transfer backpressure

**Files:**
- Modify: `packages/rtc/src/index.test.ts`
- Modify: `packages/rtc/src/transport/mesh.ts`

**Interfaces:**
- Consumes: `RTCDataChannel.bufferedAmount`, `bufferedamountlow`, `close`, and `error`.
- Produces: `waitForTransferBufferedAmountLow(peerId, threshold)` that resolves promptly whenever the observed buffer reaches the requested threshold, even if the native event is missed or another waiter changes the channel threshold.

- [x] **Step 1: Add a failing RTC test** that drains the fake channel between the initial condition check and listener registration.
- [x] **Step 2: Run the focused RTC test** and verify the promise remains unresolved under the old implementation.
- [x] **Step 3: Implement condition-based waiting** that registers listeners, rechecks immediately, polls briefly as a fallback, cleans up every timer/listener, and preserves close/error/timeout failures.
- [x] **Step 4: Add a concurrency regression test** for simultaneous 1 MiB and zero-byte drain waits on the same channel.
- [x] **Step 5: Run RTC tests and typecheck** and verify they pass.

### Task 4: Integrated verification

**Files:**
- No production files.

- [x] **Step 1: Run the focused web and RTC suites.**
- [x] **Step 2: Run repository typecheck and the web production build.**
- [x] **Step 3: Review the final diff** for temporary URL leaks, accidental immediate sends, and unrelated modifications.
