import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  resolveStorage: undefined as undefined | ((storage: object) => void),
  constructed: 0,
  latest: undefined as EventTarget | undefined,
}));

vi.mock("../services/attachments/desktop-storage", () => ({
  createAttachmentStorage: () => new Promise((resolve) => { runtime.resolveStorage = resolve; }),
}));

vi.mock("../services/attachments/attachment-service", () => ({
  AttachmentService: class extends EventTarget {
    constructor() {
      super();
      runtime.constructed += 1;
      runtime.latest = this;
    }
  },
}));

import {
  ChatAttachmentService,
  type AttachmentRuntimeState,
  type StoredAttachmentRecord,
} from "./AttachmentService";
import { RuntimeActivityTracker } from "../performance/activity";

const record = (
  transferId: string,
  state: StoredAttachmentRecord["state"],
): StoredAttachmentRecord => ({
  recordId: `record:${transferId}`,
  attachmentId: `attachment:${transferId}`,
  transferId,
  channelId: "channel_12345678",
  peerId: "peer_remote_12345678",
  direction: "incoming",
  manifest: {
    protocolVersion: 1,
    id: `attachment:${transferId}`,
    channelId: "channel_12345678",
    senderPeerId: "peer_remote_12345678",
    filename: "document.txt",
    mimeType: "text/plain",
    kind: "document",
    size: 4,
    contentHash: "a".repeat(64),
    chunkSize: 4,
    chunkCount: 1,
    createdAt: "2026-09-15T12:00:00.000Z",
  },
  state,
  bytesTransferred: 0,
  totalBytes: 4,
  retryCount: 0,
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
});

async function connect(service: ChatAttachmentService): Promise<EventTarget> {
  const connecting = service.connect(
    {} as never,
    "channel_12345678",
    "peer_local_12345678",
    () => [],
    () => true,
  );
  await vi.waitFor(() => expect(runtime.resolveStorage).toBeTypeOf("function"));
  runtime.resolveStorage!({});
  await expect(connecting).resolves.toBe(1);
  return runtime.latest!;
}

describe("ChatAttachmentService", () => {
  beforeEach(() => {
    runtime.resolveStorage = undefined;
    runtime.constructed = 0;
    runtime.latest = undefined;
  });

  it("não instala anexos de uma sessão que ficou obsoleta durante a abertura do storage", async () => {
    const service = new ChatAttachmentService();
    let current = true;
    const connecting = service.connect(
      {} as never,
      "channel_12345678",
      "peer_local_12345678",
      () => [],
      () => current,
    );
    await vi.waitFor(() => expect(runtime.resolveStorage).toBeTypeOf("function"));
    current = false;
    runtime.resolveStorage!({});

    await expect(connecting).resolves.toBeUndefined();
    expect(service.isConnected()).toBe(false);
    expect(runtime.constructed).toBe(0);
  });

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

  it("deduplicates repeated attachment and progress observations for one transfer", async () => {
    const activity = new RuntimeActivityTracker();
    const service = new ChatAttachmentService(activity);
    const attachmentService = await connect(service);

    attachmentService.dispatchEvent(new CustomEvent("attachment", { detail: record("a", "accepted") }));
    attachmentService.dispatchEvent(new CustomEvent<AttachmentRuntimeState>("progress", {
      detail: {
        record: record("a", "queued"),
        progressPercent: 0,
        speedBytesPerSecond: 0,
      },
    }));

    expect(activity.getSnapshot().transferActive).toBe(true);

    attachmentService.dispatchEvent(new CustomEvent("attachment", { detail: record("a", "completed") }));

    expect(activity.getSnapshot().transferActive).toBe(false);
  });

  it.each(["offered", "waiting", "paused", "completed", "failed", "cancelled"] as const)(
    "releases transfer activity when a transfer becomes %s",
    (state) => {
      const activity = new RuntimeActivityTracker();
      const service = new ChatAttachmentService(activity);

      service.observeTransferState("a", "transferring");
      service.observeTransferState("a", state);

      expect(activity.getSnapshot().transferActive).toBe(false);
    },
  );

  it("releases all remaining transfer activity when cleared", () => {
    const activity = new RuntimeActivityTracker();
    const service = new ChatAttachmentService(activity);
    service.observeTransferState("a", "accepted");
    service.observeTransferState("b", "verifying");

    service.clear();

    expect(activity.getSnapshot().transferActive).toBe(false);
  });
});
