import { ChatController } from "../../chat";
import type { LocalGroup } from "../offline/social-storage";

const MAX_BACKGROUND_CHANNELS = 8;

export class BackgroundChatManager {
  private readonly sessions = new Map<string, ChatController>();
  private readonly unread = new Map<string, number>();
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

  async sync(groups: LocalGroup[], displayName: string, iceServers: RTCIceServer[], activeChannelId?: string): Promise<void> {
    const desired = groups.flatMap((group) => group.channels.filter((channel) => channel.kind === "text").map((channel) => channel.id))
      .filter((channelId) => channelId !== activeChannelId)
      .slice(0, MAX_BACKGROUND_CHANNELS);
    await Promise.all([...this.sessions].filter(([channelId]) => !desired.includes(channelId)).map(async ([channelId, controller]) => {
      this.sessions.delete(channelId);
      await controller.disconnect();
    }));
    await Promise.all(desired.map(async (channelId) => {
      if (this.sessions.has(channelId)) return;
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
      await controller.connect(channelId, displayName, iceServers).catch(() => {
        this.sessions.delete(channelId);
        return controller.disconnect();
      });
    }));
  }

  async disconnect(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.disconnect()));
  }
}
