import type { LocalChatMessage } from "../offline/chat-storage";

const listeners = new Set<(message: LocalChatMessage) => void>();
const delivered = new Set<string>();

export function onIncomingMessage(listener: (message: LocalChatMessage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function announceIncomingMessage(message: LocalChatMessage): void {
  const key = `${message.channelId}:${message.id}`;
  if (delivered.has(key) || message.deletedAt) return;
  delivered.add(key);
  if (delivered.size > 2048) delivered.delete(delivered.values().next().value!);
  listeners.forEach((listener) => listener(message));
}
