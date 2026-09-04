import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  deleteAllByIndex: vi.fn(async () => undefined),
  getAllByIndex: vi.fn(),
  backendRequest: vi.fn(async () => ({ ok: true })),
  desktopConfig: vi.fn(async () => null as { baseUrl: string; token?: string } | null),
}));

vi.mock("./database", () => ({
  OFFLINE_STORES: {
    messages: "chat-messages",
    chatEvents: "chat-events",
    outbox: "chat-outbox",
    syncCheckpoints: "sync-checkpoints",
    attachments: "attachments",
    attachmentChunks: "attachment-chunks",
  },
  deleteAllByIndex: runtime.deleteAllByIndex,
  getAllByIndex: runtime.getAllByIndex,
}));

vi.mock("./desktop-backend-client", () => ({
  backendRequest: runtime.backendRequest,
  desktopConfig: runtime.desktopConfig,
}));

import { purgeLocalChannelData } from "./data-purge";

describe("purgeLocalChannelData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("indexedDB", {});
    runtime.desktopConfig.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("removes every channel projection and orphaned attachment chunks", async () => {
    runtime.getAllByIndex.mockImplementation(async (store: string, index: string) => {
      if (store === "attachments" && index === "channelId") {
        return [{ attachmentId: "a".repeat(64) }];
      }
      return [];
    });

    await purgeLocalChannelData("channel_purge_12345678");

    for (const store of ["chat-messages", "chat-events", "chat-outbox", "sync-checkpoints", "attachments"]) {
      expect(runtime.deleteAllByIndex).toHaveBeenCalledWith(store, "channelId", "channel_purge_12345678");
    }
    expect(runtime.deleteAllByIndex).toHaveBeenCalledWith("attachment-chunks", "attachmentId", "a".repeat(64));
  });

  it("preserves chunks still referenced by another channel and purges the Rust projection", async () => {
    runtime.getAllByIndex.mockImplementation(async (store: string, index: string) => {
      if (store === "attachments" && index === "channelId") return [{ attachmentId: "b".repeat(64) }];
      if (store === "attachments" && index === "attachmentId") return [{ attachmentId: "b".repeat(64), channelId: "other_channel_123" }];
      return [];
    });
    runtime.desktopConfig.mockResolvedValue({ baseUrl: "http://127.0.0.1:1234", token: "token" });

    await purgeLocalChannelData("channel_purge_12345678");

    expect(runtime.deleteAllByIndex).not.toHaveBeenCalledWith("attachment-chunks", "attachmentId", "b".repeat(64));
    expect(runtime.backendRequest).toHaveBeenCalledWith(
      { baseUrl: "http://127.0.0.1:1234", token: "token" },
      "channels",
      "channel_purge_12345678",
      { method: "POST" },
    );
  });
});
