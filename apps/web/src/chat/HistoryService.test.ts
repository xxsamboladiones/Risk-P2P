import { describe, expect, it, vi } from "vitest";
import type { LocalChatMessage } from "../services/offline/chat-storage";
import { HistoryService, type HistoryPeerContext } from "./HistoryService";
import type { MessageService } from "./MessageService";
import type { HistoryCompleteWireMessage, HistoryRequestWireMessage } from "./MessageProtocol";

function context(sent: string[]): HistoryPeerContext {
  return {
    channelId: "channel_history_12345678",
    remotePeerId: "peer_history_12345678",
    send: (wire) => { sent.push(wire); return 1; },
    isActive: () => true,
    includeEvents: true,
  };
}

function fakeMessages(overrides: Partial<MessageService> = {}): MessageService {
  return {
    history: vi.fn(async () => []),
    eventHistory: vi.fn(async () => []),
    hasProcessed: vi.fn(() => false),
    hasProcessedEvent: vi.fn(() => false),
    persistSigned: vi.fn(async () => undefined),
    persistEvent: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as MessageService;
}

describe("HistoryService pagination", () => {
  it("requests the next message and event pages until both streams finish", async () => {
    const sent: string[] = [];
    const service = new HistoryService(fakeMessages(), async () => true, async () => true);
    await service.request(context(sent));
    const first = JSON.parse(sent[0]!) as HistoryRequestWireMessage;

    service.acceptComplete(first.channelId === "channel_history_12345678" ? "peer_history_12345678" : "", {
      version: 2,
      type: "chat.history.complete",
      channelId: first.channelId,
      requestId: first.requestId,
      nextMessageBefore: "2026-01-01T00:00:00.000Z",
      nextMessageBeforeId: "message_history_0002",
      nextEventBeforeTimestamp: 1_767_225_600_000,
      nextEventBeforeId: "event_history_0002",
    });

    const second = JSON.parse(sent[1]!) as HistoryRequestWireMessage;
    expect(second.requestId).not.toBe(first.requestId);
    expect(second).toMatchObject({
      messageBefore: "2026-01-01T00:00:00.000Z",
      messageBeforeId: "message_history_0002",
      eventBeforeTimestamp: 1_767_225_600_000,
      eventBeforeId: "event_history_0002",
      knownIds: [],
      knownEventIds: [],
    });

    service.acceptComplete("peer_history_12345678", {
      version: 2,
      type: "chat.history.complete",
      channelId: second.channelId,
      requestId: second.requestId,
    });
    expect(sent).toHaveLength(2);
  });

  it("returns a composite cursor when a responder has another full page", async () => {
    const page: LocalChatMessage[] = Array.from({ length: 200 }, (_, index) => ({
      id: `message_${String(index).padStart(8, "0")}`,
      channelId: "channel_history_12345678",
      author: "Ana",
      authorPeerId: "peer_history_12345678",
      content: `Mensagem ${index}`,
      createdAt: new Date(index + 1).toISOString(),
      signature: "A".repeat(86),
    }));
    const messages = fakeMessages({ history: vi.fn(async () => page) });
    const sent: string[] = [];
    const service = new HistoryService(messages, async () => true, async () => true);

    await service.respond(context(sent), {
      version: 2,
      type: "chat.history.request",
      channelId: "channel_history_12345678",
      requestId: "request_history_12345678",
      knownIds: [],
      eventsDone: true,
    });

    const complete = JSON.parse(sent.at(-1)!) as HistoryCompleteWireMessage;
    expect(complete).toMatchObject({
      type: "chat.history.complete",
      nextMessageBefore: page[0]!.createdAt,
      nextMessageBeforeId: page[0]!.id,
    });
    expect(sent.filter((wire) => JSON.parse(wire).type === "chat.history.chunk")).toHaveLength(25);
  });

  it("stops a peer that repeats the same cursor", async () => {
    const sent: string[] = [];
    const service = new HistoryService(fakeMessages(), async () => true, async () => true);
    await service.request({ ...context(sent), includeEvents: false });
    const first = JSON.parse(sent[0]!) as HistoryRequestWireMessage;
    const next = {
      version: 2,
      type: "chat.history.complete",
      channelId: first.channelId,
      requestId: first.requestId,
      nextMessageBefore: "2026-01-01T00:00:00.000Z",
      nextMessageBeforeId: "message_history_0002",
    } satisfies HistoryCompleteWireMessage;
    service.acceptComplete("peer_history_12345678", next);
    const second = JSON.parse(sent[1]!) as HistoryRequestWireMessage;
    service.acceptComplete("peer_history_12345678", { ...next, requestId: second.requestId });

    expect(sent).toHaveLength(2);
  });
});
