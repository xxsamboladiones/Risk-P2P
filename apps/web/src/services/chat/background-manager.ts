import { ChatController, type ChatConnectionOptions, type ChatConnectionStatus } from "../../chat";
import type { LocalGroup } from "../offline/social-storage";

const MAX_BACKGROUND_CHANNELS = 8;
export const MAX_BACKGROUND_PRIVATE_CHATS = 8;

type PrivateChatSession = {
  controller: ChatController;
  status: ChatConnectionStatus;
  lastUsedAt: number;
  connecting?: Promise<void>;
  offStatus: () => void;
  offMessage: () => void;
};

export type PrivateChatSessionSnapshot = {
  controller: ChatController;
  status: ChatConnectionStatus;
};

export class BackgroundChatManager {
  private readonly sessions = new Map<string, ChatController>();
  private readonly privateSessions = new Map<string, PrivateChatSession>();
  private readonly unread = new Map<string, number>();
  private desiredChannels = new Set<string>();
  private listener?: (unread: ReadonlyMap<string, number>) => void;
  private privateUseCounter = 0;

  onUnread(listener: (unread: ReadonlyMap<string, number>) => void): () => void {
    this.listener = listener;
    listener(new Map(this.unread));
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  clear(channelId: string): void {
    if (!this.unread.delete(channelId)) return;
    this.listener?.(new Map(this.unread));
  }

  privateSession(channelId: string): PrivateChatSessionSnapshot | undefined {
    const session = this.privateSessions.get(channelId);
    if (!session) return undefined;
    session.lastUsedAt = ++this.privateUseCounter;
    return { controller: session.controller, status: session.status };
  }

  async connectPrivate(
    channelId: string,
    displayName: string,
    iceServers: RTCIceServer[],
    options: ChatConnectionOptions,
  ): Promise<ChatController> {
    const existing = this.privateSessions.get(channelId);
    if (existing && existing.status !== "error" && existing.status !== "incompatible" && existing.status !== "disconnected") {
      existing.lastUsedAt = ++this.privateUseCounter;
      if (existing.connecting) await existing.connecting;
      return existing.controller;
    }
    if (existing) await this.disconnectPrivate(channelId);
    await this.evictPrivateSessionIfNeeded();

    const controller = new ChatController();
    const session: PrivateChatSession = {
      controller,
      status: "disconnected",
      lastUsedAt: ++this.privateUseCounter,
      offStatus: () => undefined,
      offMessage: () => undefined,
    };
    session.offStatus = controller.onStatus((status) => { session.status = status; });
    session.offMessage = controller.onMessage((message) => {
      if (message.channelId !== channelId) return;
      this.unread.set(channelId, (this.unread.get(channelId) ?? 0) + 1);
      this.listener?.(new Map(this.unread));
      if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
        new Notification("Nova mensagem privada no Risk", { body: `${message.author}: ${message.content.slice(0, 120)}` });
      }
    });
    this.privateSessions.set(channelId, session);

    const connecting = controller.connect(channelId, displayName, iceServers, options);
    session.connecting = connecting;
    try {
      await connecting;
    } catch (error) {
      if (this.privateSessions.get(channelId) === session) {
        this.privateSessions.delete(channelId);
        session.offStatus();
        session.offMessage();
      }
      await controller.disconnect().catch(() => undefined);
      throw error;
    } finally {
      if (this.privateSessions.get(channelId) === session) session.connecting = undefined;
    }
    return controller;
  }

  async disconnectPrivate(channelId: string): Promise<void> {
    const session = this.privateSessions.get(channelId);
    if (!session) return;
    this.privateSessions.delete(channelId);
    session.offStatus();
    session.offMessage();
    this.clear(channelId);
    await session.controller.disconnect();
  }

  async release(channelId: string): Promise<void> {
    this.desiredChannels.delete(channelId);
    const controller = this.sessions.get(channelId);
    if (!controller) return;
    this.sessions.delete(channelId);
    await controller.disconnect();
  }

  async sync(
    groups: LocalGroup[],
    displayName: string,
    iceServers: RTCIceServer[],
    activeChannelId?: string,
    reservedChannelIds: readonly string[] = [],
  ): Promise<void> {
    const excluded = new Set<string>(reservedChannelIds);
    if (activeChannelId) excluded.add(activeChannelId);
    const desired = groups.flatMap((group) => group.channels.filter((channel) => channel.kind === "text").map((channel) => channel.id))
      .filter((channelId) => !excluded.has(channelId))
      .slice(0, MAX_BACKGROUND_CHANNELS);
    this.desiredChannels = new Set(desired);

    await Promise.all([...this.sessions].filter(([channelId]) => !this.desiredChannels.has(channelId)).map(async ([channelId, controller]) => {
      if (this.sessions.get(channelId) !== controller) return;
      this.sessions.delete(channelId);
      await controller.disconnect();
    }));

    await Promise.all(desired.map(async (channelId) => {
      if (!this.desiredChannels.has(channelId) || this.sessions.has(channelId)) return;
      const controller = new ChatController();
      this.sessions.set(channelId, controller);
      controller.onMessage((message) => {
        if (message.channelId !== channelId) return;
        this.unread.set(channelId, (this.unread.get(channelId) ?? 0) + 1);
        this.listener?.(new Map(this.unread));
        if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
          new Notification("Nova mensagem no Risk", { body: `${message.author}: ${message.content.slice(0, 120)}` });
        }
      });
      try {
        await controller.connect(channelId, displayName, iceServers);
        if (!this.desiredChannels.has(channelId) || this.sessions.get(channelId) !== controller) {
          if (this.sessions.get(channelId) === controller) this.sessions.delete(channelId);
          await controller.disconnect();
        }
      } catch {
        if (this.sessions.get(channelId) === controller) this.sessions.delete(channelId);
        await controller.disconnect();
      }
    }));
  }

  async disconnect(): Promise<void> {
    this.desiredChannels.clear();
    const sessions = [...this.sessions.values()];
    const privateSessions = [...this.privateSessions.values()];
    this.sessions.clear();
    this.privateSessions.clear();
    privateSessions.forEach((session) => { session.offStatus(); session.offMessage(); });
    await Promise.all([
      ...sessions.map((session) => session.disconnect()),
      ...privateSessions.map((session) => session.controller.disconnect()),
    ]);
  }

  private async evictPrivateSessionIfNeeded(): Promise<void> {
    if (this.privateSessions.size < MAX_BACKGROUND_PRIVATE_CHATS) return;
    const oldest = [...this.privateSessions.entries()]
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (oldest) await this.disconnectPrivate(oldest[0]);
  }
}
