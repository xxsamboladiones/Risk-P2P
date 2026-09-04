import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  failMessageSave: false,
  failEventSave: false,
  existingMessage: undefined as Record<string, unknown> | undefined,
  saveMessage: vi.fn(async (_value: unknown) => undefined),
  saveEvent: vi.fn(async (_value: unknown) => undefined),
}));

vi.mock("../services/offline/chat-storage", async () => {
  const actual = await vi.importActual<typeof import("../services/offline/chat-storage")>("../services/offline/chat-storage");
  return {
    ...actual,
    loadLocalMessage: vi.fn(async () => runtime.existingMessage),
    loadLocalMessages: vi.fn(async () => []),
    saveLocalMessage: vi.fn(async (...args: unknown[]) => {
      if (runtime.failMessageSave) {
        runtime.failMessageSave = false;
        throw new Error("storage unavailable");
      }
      await runtime.saveMessage(args[0]);
    }),
  };
});

vi.mock("../services/offline/chat-event-storage", async () => {
  const actual = await vi.importActual<typeof import("../services/offline/chat-event-storage")>("../services/offline/chat-event-storage");
  return {
    ...actual,
    loadLocalChatEvents: vi.fn(async () => []),
    saveLocalChatEvent: vi.fn(async (...args: unknown[]) => {
      if (runtime.failEventSave) {
        runtime.failEventSave = false;
        throw new Error("event storage unavailable");
      }
      await runtime.saveEvent(args[0]);
    }),
  };
});

import { MessageService } from "./MessageService";
import type { SignedChatEventWireMessage, SignedChatWireMessage } from "./MessageProtocol";

describe("MessageService persistence failures", () => {
  beforeEach(() => {
    runtime.failMessageSave = false;
    runtime.failEventSave = false;
    runtime.existingMessage = undefined;
    vi.clearAllMocks();
  });

  it("allows a received message to be retried when its first storage write fails", async () => {
    const service = new MessageService();
    const message: SignedChatWireMessage = {
      version: 2,
      type: "chat.message",
      channelId: "channel_retry_12345678",
      id: "message_retry_12345678",
      authorPeerId: "peer_retry_12345678",
      author: "Ana",
      content: "Olá",
      timestamp: 1,
      signature: "A".repeat(86),
    };
    runtime.failMessageSave = true;

    await expect(service.persistSigned(message)).rejects.toThrow("storage unavailable");
    expect(service.hasProcessed(message.id)).toBe(false);

    await expect(service.persistSigned(message)).resolves.toMatchObject({ id: message.id });
    expect(service.hasProcessed(message.id)).toBe(true);
  });

  it("allows a received event to be retried when its storage write fails", async () => {
    const service = new MessageService();
    const event: SignedChatEventWireMessage = {
      version: 3,
      type: "chat.event",
      channelId: "channel_retry_12345678",
      id: "event_retry_12345678",
      targetMessageId: "message_retry_12345678",
      actorPeerId: "peer_retry_12345678",
      action: "reaction.add",
      emoji: "👍",
      timestamp: 1,
      signature: "A".repeat(86),
    };
    runtime.failEventSave = true;

    await expect(service.persistEvent(event)).rejects.toThrow("event storage unavailable");
    expect(service.hasProcessedEvent(event.id)).toBe(false);

    await expect(service.persistEvent(event)).resolves.toBeUndefined();
    expect(service.hasProcessedEvent(event.id)).toBe(true);
  });

  it("does not revert an existing materialized state when the base message is received again", async () => {
    const service = new MessageService();
    runtime.existingMessage = {
      id: "message_retry_12345678",
      channelId: "channel_retry_12345678",
      author: "Ana",
      authorPeerId: "peer_retry_12345678",
      content: "Original",
      createdAt: new Date(1).toISOString(),
      signature: "A".repeat(86),
      editedContent: "Editada",
      editedAt: new Date(2).toISOString(),
      deletedAt: new Date(3).toISOString(),
      reactions: { "👍": ["peer_retry_12345678"] },
    };

    await service.persistSigned({
      version: 2,
      type: "chat.message",
      channelId: "channel_retry_12345678",
      id: "message_retry_12345678",
      authorPeerId: "peer_retry_12345678",
      author: "Ana",
      content: "Original",
      timestamp: 1,
      signature: "A".repeat(86),
    });

    expect(runtime.saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      editedContent: "Editada",
      deletedAt: new Date(3).toISOString(),
      reactions: { "👍": ["peer_retry_12345678"] },
    }));
  });

  it("finds an old message directly instead of depending on the latest history page", async () => {
    const service = new MessageService();
    runtime.existingMessage = {
      id: "message_old_12345678",
      channelId: "channel_retry_12345678",
      author: "Ana",
      content: "Mensagem antiga",
      createdAt: new Date(1).toISOString(),
    };

    await expect(service.find("channel_retry_12345678", "message_old_12345678"))
      .resolves.toMatchObject({ id: "message_old_12345678", content: "Mensagem antiga" });
  });
});
