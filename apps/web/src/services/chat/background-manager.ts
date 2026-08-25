import { ChatController } from "../../chat";
import type { LocalGroup } from "../offline/social-storage";

const MAX_BACKGROUND_CHANNELS = 8;

export class BackgroundChatManager {
  private readonly sessions = new Map<string, ChatController>();
  private readonly unread = new Map<string, number>();
  private desiredChannels = new Set<string>();
  private listener?: (unread: ReadonlyMap<string, number>) => void;

  onUnread(listener: (unread: ReadonlyMap<string, number>) => void): () => void {
    this.listener = listener;
    listener(new Map(this.unread));
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  clear(channelId: string): void {
    if (!this.unread.delete(channelId)) return;
    this.listener?.(new Map(this.unread));
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
          new Notification(`Nova mensagem no Risk`, { body: `${message.author}: ${message.content.slice(0, 120)}` });
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
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.disconnect()));
  }
}
