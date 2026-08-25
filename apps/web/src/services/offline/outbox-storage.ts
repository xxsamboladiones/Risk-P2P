import { OFFLINE_STORES, deleteFromStore, getAllByIndex, putInStore } from "./database";

export type OutboxRecord = {
  key: string;
  channelId: string;
  messageId: string;
  wire: string;
  queuedAt: number;
  attempts: number;
};

const memoryFallback = new Map<string, OutboxRecord>();

export async function enqueueOutbox(channelId: string, messageId: string, wire: string): Promise<void> {
  const record = { key: `${channelId}:${messageId}`, channelId, messageId, wire, queuedAt: Date.now(), attempts: 0 } satisfies OutboxRecord;
  if (typeof indexedDB === "undefined") { memoryFallback.set(record.key, record); return; }
  await putInStore(OFFLINE_STORES.outbox, record);
}

export function loadOutbox(channelId: string): Promise<OutboxRecord[]> {
  if (typeof indexedDB === "undefined") return Promise.resolve([...memoryFallback.values()].filter((record) => record.channelId === channelId));
  return getAllByIndex<OutboxRecord>(OFFLINE_STORES.outbox, "channelId", channelId);
}

export function removeOutbox(channelId: string, messageId: string): Promise<void> {
  if (typeof indexedDB === "undefined") { memoryFallback.delete(`${channelId}:${messageId}`); return Promise.resolve(); }
  return deleteFromStore(OFFLINE_STORES.outbox, `${channelId}:${messageId}`);
}

export function markOutboxAttempt(record: OutboxRecord): Promise<void> {
  if (typeof indexedDB === "undefined") { memoryFallback.set(record.key, { ...record, attempts: record.attempts + 1 }); return Promise.resolve(); }
  return putInStore(OFFLINE_STORES.outbox, { ...record, attempts: record.attempts + 1 } satisfies OutboxRecord);
}
