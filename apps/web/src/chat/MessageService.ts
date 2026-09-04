import {
  canonicalChatEvent,
  bytesToBase64Url,
  canonicalSignedMessage,
  legacyToLocal,
  signedToLocal,
  type LegacyChatWireMessage,
  type SignedChatEventWireMessage,
  type SignedChatWireMessage,
} from "./MessageProtocol";
import {
  loadLocalMessage,
  loadLocalMessages,
  saveLocalMessage,
  type LocalChatMessage,
  type MessagePageOptions,
} from "../services/offline/chat-storage";
import type { LocalIdentity } from "../services/offline/social-storage";
import {
  compareEvents,
  loadLocalChatEvents,
  saveLocalChatEvent,
} from "../services/offline/chat-event-storage";
import type { ChatEventPageOptions } from "../services/offline/chat-event-storage";

export type ChatMessageChange = "created" | "updated";
export type ChatEventInput =
  | { action: "reply"; referenceMessageId: string }
  | { action: "edit"; content: string }
  | { action: "delete" }
  | { action: "reaction.add" | "reaction.remove"; emoji: string }
  | { action: "pin" | "unpin" };

export class MessageService {
  private readonly processed = new Set<string>();
  private readonly processedEvents = new Set<string>();
  private readonly callbacks = new Set<(message: LocalChatMessage, change: ChatMessageChange) => void>();
  private readonly messageCache = new Map<string, LocalChatMessage>();
  private readonly projectionEvents = new Map<string, SignedChatEventWireMessage[]>();
  private readonly eventWrites = new Map<string, Promise<LocalChatMessage | undefined>>();
  private lastEventTimestamp = 0;

  async history(channelId: string, options?: MessagePageOptions): Promise<LocalChatMessage[]> {
    const [messages, events] = await Promise.all([
      loadLocalMessages(channelId, options),
      this.loadProjectionEvents(channelId),
    ]);
    return messages.map((message) => {
      const projected = projectMessage(message, events);
      this.messageCache.set(this.cacheKey(channelId, message.id), projected);
      return projected;
    });
  }

  onMessage(callback: (message: LocalChatMessage, change: ChatMessageChange) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  resetSession(): void {
    this.processed.clear();
    this.processedEvents.clear();
    this.messageCache.clear();
    this.projectionEvents.clear();
    this.eventWrites.clear();
    this.lastEventTimestamp = 0;
  }
  hasProcessed(messageId: string): boolean { return this.processed.has(messageId); }
  hasProcessedEvent(eventId: string): boolean { return this.processedEvents.has(eventId); }

  eventHistory(channelId: string, options?: ChatEventPageOptions): Promise<SignedChatEventWireMessage[]> {
    return loadLocalChatEvents(channelId, options);
  }

  async find(channelId: string, messageId: string): Promise<LocalChatMessage | undefined> {
    const key = this.cacheKey(channelId, messageId);
    const cached = this.messageCache.get(key);
    if (cached) return cached;
    const stored = await loadLocalMessage(channelId, messageId);
    if (!stored) return undefined;
    const projected = projectMessage(stored, await this.loadProjectionEvents(channelId));
    this.messageCache.set(key, projected);
    return projected;
  }

  validateContent(content: string): string {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 4_000) throw new Error("Mensagem inválida.");
    return trimmed;
  }

  createLegacy(channelId: string, author: string, content: string, timestamp = Date.now()): LegacyChatWireMessage {
    return {
      version: 1,
      type: "chat.message",
      channelId,
      id: crypto.randomUUID(),
      author,
      content: this.validateContent(content),
      timestamp,
    };
  }

  async createSigned(
    identity: LocalIdentity,
    channelId: string,
    author: string,
    content: string,
    timestamp = Date.now(),
  ): Promise<SignedChatWireMessage> {
    const unsigned: Omit<SignedChatWireMessage, "signature"> = {
      version: 2,
      type: "chat.message",
      channelId,
      id: crypto.randomUUID(),
      authorPeerId: identity.peerId,
      author,
      content: this.validateContent(content),
      timestamp,
    };
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(canonicalSignedMessage(unsigned)),
    );
    return { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
  }

  async createEvent(
    identity: LocalIdentity,
    channelId: string,
    targetMessageId: string,
    input: ChatEventInput,
    timestamp = Date.now(),
  ): Promise<SignedChatEventWireMessage> {
    const eventTimestamp = Math.max(timestamp, this.lastEventTimestamp + 1);
    this.lastEventTimestamp = eventTimestamp;
    const unsigned: Omit<SignedChatEventWireMessage, "signature"> = {
      version: 3,
      type: "chat.event",
      channelId,
      id: crypto.randomUUID(),
      targetMessageId,
      actorPeerId: identity.peerId,
      action: input.action,
      ...("content" in input ? { content: this.validateContent(input.content) } : {}),
      ...("referenceMessageId" in input ? { referenceMessageId: input.referenceMessageId } : {}),
      ...("emoji" in input ? { emoji: validateEmoji(input.emoji) } : {}),
      timestamp: eventTimestamp,
    };
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(canonicalChatEvent(unsigned)),
    );
    return { ...unsigned, signature: bytesToBase64Url(new Uint8Array(signature)) };
  }

  async persistSigned(message: SignedChatWireMessage): Promise<LocalChatMessage> {
    return this.persist(signedToLocal(message));
  }

  async persistLegacy(message: LegacyChatWireMessage, author: string): Promise<LocalChatMessage> {
    return this.persist(legacyToLocal(message, author));
  }

  async persistEvent(event: SignedChatEventWireMessage): Promise<LocalChatMessage | undefined> {
    const previous = this.eventWrites.get(event.channelId) ?? Promise.resolve(undefined);
    const task = previous.catch(() => undefined).then(() => this.persistEventNow(event));
    this.eventWrites.set(event.channelId, task);
    try { return await task; }
    finally { if (this.eventWrites.get(event.channelId) === task) this.eventWrites.delete(event.channelId); }
  }

  private async persistEventNow(event: SignedChatEventWireMessage): Promise<LocalChatMessage | undefined> {
    await saveLocalChatEvent(event);
    const projectionEvents = await this.loadProjectionEvents(event.channelId);
    if (!projectionEvents.some((item) => item.id === event.id)) {
      projectionEvents.push(event);
      projectionEvents.sort(compareEvents);
    }
    const key = this.cacheKey(event.channelId, event.targetMessageId);
    let message = this.messageCache.get(key);
    if (!message) {
      message = await loadLocalMessage(event.channelId, event.targetMessageId);
    }
    if (!message) {
      this.rememberEvent(event.id);
      return undefined;
    }
    const projected = projectMessage(message, projectionEvents);
    await saveLocalMessage(projected);
    this.rememberEvent(event.id);
    this.messageCache.set(key, projected);
    this.callbacks.forEach((callback) => callback(projected, "updated"));
    return projected;
  }

  private async persist(message: LocalChatMessage): Promise<LocalChatMessage> {
    const key = this.cacheKey(message.channelId, message.id);
    const existing = this.messageCache.get(key) ?? await loadLocalMessage(message.channelId, message.id);
    const projectionBase: LocalChatMessage = existing ? {
      ...message,
      replyToId: existing.replyToId,
      editedContent: existing.editedContent,
      editedAt: existing.editedAt,
      deletedAt: existing.deletedAt,
      pinnedAt: existing.pinnedAt,
      pinnedByPeerId: existing.pinnedByPeerId,
      reactions: existing.reactions,
    } : message;
    const projected = projectMessage(projectionBase, await this.loadProjectionEvents(message.channelId));
    await saveLocalMessage(projected);
    this.remember(message.id);
    this.messageCache.set(key, projected);
    this.callbacks.forEach((callback) => callback(projected, "created"));
    return projected;
  }

  private remember(messageId: string): void {
    this.processed.add(messageId);
    while (this.processed.size > 2_048) this.processed.delete(this.processed.values().next().value!);
  }

  private rememberEvent(eventId: string): void {
    this.processedEvents.add(eventId);
    while (this.processedEvents.size > 4_096) this.processedEvents.delete(this.processedEvents.values().next().value!);
  }

  private cacheKey(channelId: string, messageId: string): string { return `${channelId}:${messageId}`; }

  private async loadProjectionEvents(channelId: string): Promise<SignedChatEventWireMessage[]> {
    const cached = this.projectionEvents.get(channelId);
    if (cached) return cached;
    const events = await loadLocalChatEvents(channelId);
    const concurrentlyLoaded = this.projectionEvents.get(channelId);
    if (concurrentlyLoaded) {
      const known = new Set(concurrentlyLoaded.map((event) => event.id));
      concurrentlyLoaded.push(...events.filter((event) => !known.has(event.id)));
      concurrentlyLoaded.sort(compareEvents);
      return concurrentlyLoaded;
    }
    this.projectionEvents.set(channelId, events);
    return events;
  }
}

export function projectMessage(message: LocalChatMessage, events: SignedChatEventWireMessage[]): LocalChatMessage {
  const projected: LocalChatMessage = {
    ...message,
    replyToId: message.replyToId ?? null,
    editedContent: message.editedContent ?? null,
    editedAt: message.editedAt ?? null,
    deletedAt: message.deletedAt ?? null,
    pinnedAt: message.pinnedAt ?? null,
    pinnedByPeerId: message.pinnedByPeerId ?? null,
    reactions: message.reactions ?? {},
  };
  const reactions = new Map(Object.entries(message.reactions ?? {})
    .map(([emoji, peers]) => [emoji, new Set(peers)]));
  for (const event of events.filter((item) => item.targetMessageId === message.id).sort(compareEvents)) {
    const authoredAction = event.action === "reply" || event.action === "edit" || event.action === "delete";
    if (authoredAction && (!message.authorPeerId || event.actorPeerId !== message.authorPeerId)) continue;
    const timestamp = new Date(event.timestamp).toISOString();
    switch (event.action) {
      case "reply": projected.replyToId = event.referenceMessageId ?? null; break;
      case "edit": projected.editedContent = event.content ?? null; projected.editedAt = timestamp; break;
      case "delete": projected.deletedAt = timestamp; break;
      case "pin": projected.pinnedAt = timestamp; projected.pinnedByPeerId = event.actorPeerId; break;
      case "unpin": projected.pinnedAt = null; projected.pinnedByPeerId = null; break;
      case "reaction.add": {
        const peers = reactions.get(event.emoji!) ?? new Set<string>();
        peers.add(event.actorPeerId);
        reactions.set(event.emoji!, peers);
        break;
      }
      case "reaction.remove": reactions.get(event.emoji!)?.delete(event.actorPeerId); break;
    }
  }
  projected.reactions = Object.fromEntries([...reactions]
    .filter(([, peers]) => peers.size > 0)
    .map(([emoji, peers]) => [emoji, [...peers].sort()]));
  return projected;
}

function validateEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (!trimmed || [...trimmed].length > 16) throw new Error("Reação inválida.");
  return trimmed;
}
