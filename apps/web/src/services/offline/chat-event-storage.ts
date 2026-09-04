import type { SignedChatEventWireMessage } from "../../chat/MessageProtocol";
import { OFFLINE_STORES, getAllByIndex, putInStore } from "./database";
import { backendRequest, desktopConfig } from "./desktop-backend-client";

export type LocalChatEvent = SignedChatEventWireMessage;
export type ChatEventPageOptions = { beforeTimestamp?: number; beforeId?: string; limit?: number };
const memoryFallback = new Map<string, LocalChatEvent>();

export async function loadLocalChatEvents(channelId: string, options: ChatEventPageOptions = {}): Promise<LocalChatEvent[]> {
  const config = await desktopConfig();
  if (config) {
    const requestedLimit = options.limit ? Math.max(1, Math.min(500, Math.trunc(options.limit))) : undefined;
    const result: LocalChatEvent[] = [];
    let beforeTimestamp = options.beforeTimestamp;
    let beforeId = options.beforeId;
    for (;;) {
      const limit = requestedLimit ?? 500;
      const query = `?limit=${limit}${beforeTimestamp && beforeId
        ? `&beforeTimestamp=${beforeTimestamp}&beforeId=${encodeURIComponent(beforeId)}`
        : ""}`;
      const page = await backendRequest<LocalChatEvent[]>(config, "chat-events", channelId, { method: "GET" }, query);
      result.unshift(...page);
      if (requestedLimit || page.length < limit) return result;
      const oldest = page[0]!;
      beforeTimestamp = oldest.timestamp;
      beforeId = oldest.id;
    }
  }
  if (typeof indexedDB === "undefined") return pageEvents(
    [...memoryFallback.values()].filter((event) => event.channelId === channelId),
    options,
  );
  const events = await getAllByIndex<LocalChatEvent>(OFFLINE_STORES.chatEvents, "channelId", channelId);
  return pageEvents(events, options);
}

export async function saveLocalChatEvent(event: LocalChatEvent): Promise<void> {
  const config = await desktopConfig();
  if (config) {
    await backendRequest(config, "chat-events", event.channelId, { method: "POST", body: JSON.stringify(event) });
    return;
  }
  if (typeof indexedDB === "undefined") {
    memoryFallback.set(`${event.channelId}:${event.id}`, event);
    return;
  }
  await putInStore(OFFLINE_STORES.chatEvents, event);
}

export function compareEvents(left: LocalChatEvent, right: LocalChatEvent): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

function pageEvents(events: LocalChatEvent[], options: ChatEventPageOptions): LocalChatEvent[] {
  const filtered = events.filter((event) => !options.beforeTimestamp
    || event.timestamp < options.beforeTimestamp
    || (event.timestamp === options.beforeTimestamp && Boolean(options.beforeId) && event.id < options.beforeId!));
  const sorted = filtered.sort(compareEvents);
  return options.limit ? sorted.slice(-Math.max(1, Math.trunc(options.limit))) : sorted;
}
