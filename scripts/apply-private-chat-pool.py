from pathlib import Path

MANAGER = '''import { ChatController, type ChatConnectionOptions, type ChatConnectionStatus } from "../../chat";
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
'''

TESTS = '''import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalGroup } from "../offline/social-storage";

const runtime = vi.hoisted(() => ({
  connected: [] as string[],
  disconnected: [] as string[],
}));

vi.mock("../../chat", () => ({
  ChatController: class FakeChatController {
    private channelId?: string;
    private readonly statusListeners = new Set<(status: string) => void>();

    onMessage(): () => void { return () => undefined; }
    onStatus(listener: (status: string) => void): () => void {
      this.statusListeners.add(listener);
      return () => this.statusListeners.delete(listener);
    }

    async connect(channelId: string): Promise<void> {
      this.channelId = channelId;
      runtime.connected.push(channelId);
      this.statusListeners.forEach((listener) => listener("connected"));
      this.statusListeners.forEach((listener) => listener("ready"));
    }

    async disconnect(): Promise<void> {
      if (this.channelId) runtime.disconnected.push(this.channelId);
      this.channelId = undefined;
      this.statusListeners.forEach((listener) => listener("disconnected"));
    }
  },
}));

import { BackgroundChatManager, MAX_BACKGROUND_PRIVATE_CHATS } from "./background-manager";

function groupWithTextChannels(...ids: string[]): LocalGroup {
  return {
    groupId: "group-background-test",
    name: "Teste",
    ownerPeerId: "owner-background-test",
    membershipVersion: 1,
    manifestVersion: 1,
    manifestActorPeerId: "owner-background-test",
    manifestOperationId: "operation-background-test",
    administratorEpoch: 1,
    administratorPeerIds: [],
    administratorGrants: [],
    removedPeerIds: [],
    removedMembers: [],
    revocations: [],
    rendezvousVersion: 1,
    rendezvousSecret: "A".repeat(43),
    members: [],
    channels: ids.map((id) => ({ id, name: id, kind: "text" as const, voiceRoomId: null })),
    joinedAt: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as LocalGroup;
}

describe("BackgroundChatManager", () => {
  beforeEach(() => {
    runtime.connected.length = 0;
    runtime.disconnected.length = 0;
  });

  it("não ocupa o canal ativo nem o canal reservado pela chamada", async () => {
    const manager = new BackgroundChatManager();
    const group = groupWithTextChannels("foreground", "call-chat", "background");
    await manager.sync([group], "Ana", [], "foreground", ["call-chat"]);
    expect(runtime.connected).toEqual(["background"]);
    expect(runtime.disconnected).toEqual([]);
    await manager.disconnect();
  });

  it("libera uma sessão de grupo já aberta quando a chamada assume o canal", async () => {
    const manager = new BackgroundChatManager();
    const group = groupWithTextChannels("call-chat");
    await manager.sync([group], "Ana", []);
    expect(runtime.connected).toEqual(["call-chat"]);
    await manager.release("call-chat");
    expect(runtime.disconnected).toEqual(["call-chat"]);
    await manager.sync([group], "Ana", [], undefined, ["call-chat"]);
    expect(runtime.connected).toEqual(["call-chat"]);
  });

  it("mantém oito chats privados enquanto a UI navega e sincroniza grupos", async () => {
    const manager = new BackgroundChatManager();
    for (let index = 0; index < MAX_BACKGROUND_PRIVATE_CHATS; index += 1) {
      await manager.connectPrivate(`dm-private-${index}`, "Ana", [], {});
    }
    expect(runtime.connected.filter((id) => id.startsWith("dm-private-"))).toHaveLength(8);
    for (let index = 0; index < MAX_BACKGROUND_PRIVATE_CHATS; index += 1) {
      expect(manager.privateSession(`dm-private-${index}`)?.status).toBe("ready");
    }
    await manager.sync([groupWithTextChannels("group-background")], "Ana", []);
    expect(runtime.disconnected.filter((id) => id.startsWith("dm-private-"))).toEqual([]);
    await manager.disconnect();
  });

  it("ao abrir o nono privado remove apenas a sessão menos usada", async () => {
    const manager = new BackgroundChatManager();
    for (let index = 0; index < MAX_BACKGROUND_PRIVATE_CHATS; index += 1) {
      await manager.connectPrivate(`dm-lru-${index}`, "Ana", [], {});
    }
    expect(manager.privateSession("dm-lru-0")).toBeDefined();
    await manager.connectPrivate("dm-lru-8", "Ana", [], {});
    expect(manager.privateSession("dm-lru-0")).toBeDefined();
    expect(manager.privateSession("dm-lru-1")).toBeUndefined();
    expect(manager.privateSession("dm-lru-8")?.status).toBe("ready");
    expect(runtime.disconnected).toContain("dm-lru-1");
    await manager.disconnect();
  });
});
'''

Path("apps/web/src/services/chat/background-manager.ts").write_text(MANAGER, encoding="utf-8")
Path("apps/web/src/services/chat/background-manager.test.ts").write_text(TESTS, encoding="utf-8")

main = Path("apps/web/src/main.tsx")
source = main.read_text(encoding="utf-8")

conversation_anchor = '  const conversationId = activeFriend ? privateChannelId : activeChannel?.kind === "text" ? activeChannel.id : null;\n'
if conversation_anchor not in source:
    raise SystemExit("conversation id anchor not found")
source = source.replace(
    conversation_anchor,
    conversation_anchor + '\n  const isPrivateConversation = Boolean(activeFriend);\n  const privateSession = isPrivateConversation && privateChannelId ? backgroundChats.privateSession(privateChannelId) : undefined;\n  const activeConversationChat = isPrivateConversation ? (privateSession?.controller ?? chat) : chat;\n',
    1,
)

effect_start = source.index('  useEffect(() => {\n    if (!conversationId)', source.index(conversation_anchor))
effect_end_marker = '  }, [conversationId]);'
effect_end = source.index(effect_end_marker, effect_start) + len(effect_end_marker)
new_effect = '''  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setHasOlderMessages(false);
      setAttachments([]);
      setAttachmentProgress({});
      setChatStatus("disconnected");
      return;
    }
    const session = isPrivateConversation ? backgroundChats.privateSession(conversationId) : undefined;
    const controller = isPrivateConversation ? session?.controller : chat;
    const historyController = controller ?? chat;
    if (isPrivateConversation) {
      backgroundChats.clear(conversationId);
      setChatStatus(session?.status ?? "disconnected");
    }
    let alive = true;
    const offMessage = controller?.onMessage((message) => {
      if (!alive || message.channelId !== conversationId) return;
      setMessages((current) => {
        if (current.some((item) => item.id === message.id)) return current;
        return [...current, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
    });
    const offStatus = controller?.onStatus((status) => {
      if (!alive) return;
      setChatStatus(status);
      if (status === "incompatible") setError(incompatiblePeerMessage());
    });
    const offAttachment = controller?.onAttachment((record) => {
      if (!alive || record.channelId !== conversationId) return;
      setAttachments((current) => upsertAttachment(current, record));
    });
    const offProgress = controller?.onAttachmentProgress((progress) => {
      if (!alive || progress.record.channelId !== conversationId) return;
      setAttachmentProgress((current) => ({ ...current, [progress.record.attachmentId]: progress }));
      setAttachments((current) => upsertAttachment(current, progress.record));
    });
    void Promise.all([historyController.history(conversationId), historyController.attachmentHistory(conversationId)])
      .then(([chatItems, attachmentItems]) => {
        if (!alive) return;
        setMessages([...chatItems].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        setHasOlderMessages(chatItems.length === 100);
        setAttachments(dedupeAttachments(attachmentItems));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Falha no histórico local"));
    return () => {
      alive = false;
      offMessage?.();
      offStatus?.();
      offAttachment?.();
      offProgress?.();
      if (!isPrivateConversation) void chat.disconnect();
      setChatStatus("disconnected");
      setAttachmentProgress({});
    };
  }, [conversationId, privateSession?.controller, isPrivateConversation]);'''
source = source[:effect_start] + new_effect + source[effect_end:]

old_private_connect = '''        await chat.connect(privateChannelId, currentUser.displayName, iceServers, {
          identity,
          trustedPeers: [friend],
          namespace: "friend",
          maxRemotePeers: 1,
        });
        return;'''
new_private_connect = '''        await backgroundChats.connectPrivate(privateChannelId, currentUser.displayName, iceServers, {
          identity,
          trustedPeers: [friend],
          namespace: "friend",
          maxRemotePeers: 1,
        });
        setChatStatus(backgroundChats.privateSession(privateChannelId)?.status ?? "connected");
        return;'''
if old_private_connect not in source:
    raise SystemExit("private connect anchor not found")
source = source.replace(old_private_connect, new_private_connect, 1)

source = source.replace('      else await chat.send(content);', '      else await activeConversationChat.send(content);', 1)
source = source.replace('      const older = await chat.history(conversationId, { before, limit: 100 });', '      const older = await activeConversationChat.history(conversationId, { before, limit: 100 });', 1)
source = source.replace('      for (const file of files) await chat.sendAttachment(file);', '      for (const file of files) await activeConversationChat.sendAttachment(file);', 1)

old_delete = '''        if (activeFriend?.id === target.friend.id) {
          await chat.disconnect().catch(() => undefined);
          setActiveFriend(null);
        }'''
new_delete = '''        const identity = await getOrCreateLocalIdentity(currentUser?.displayName ?? "Participante");
        const privateId = await privateConversationId(identity.peerId, target.friend.id);
        await backgroundChats.disconnectPrivate(privateId).catch(() => undefined);
        if (activeFriend?.id === target.friend.id) setActiveFriend(null);'''
if old_delete not in source:
    raise SystemExit("friend delete anchor not found")
source = source.replace(old_delete, new_delete, 1)

old_timeline = '''    loadBlob={(record) => chat.attachmentBlob(record)}
    onDownload={(record) => attachmentAction((item) => chat.downloadAttachment(item), record)}
    onRequest={(record) => attachmentAction((item) => chat.requestAttachment(item), record)}
    onPause={(record) => attachmentAction((item) => chat.pauseAttachment(item), record)}
    onResume={(record) => attachmentAction((item) => chat.resumeAttachment(item), record)}
    onCancel={(record) => attachmentAction((item) => chat.cancelAttachment(item), record)}'''
new_timeline = '''    loadBlob={(record) => activeConversationChat.attachmentBlob(record)}
    onDownload={(record) => attachmentAction((item) => activeConversationChat.downloadAttachment(item), record)}
    onRequest={(record) => attachmentAction((item) => activeConversationChat.requestAttachment(item), record)}
    onPause={(record) => attachmentAction((item) => activeConversationChat.pauseAttachment(item), record)}
    onResume={(record) => attachmentAction((item) => activeConversationChat.resumeAttachment(item), record)}
    onCancel={(record) => attachmentAction((item) => activeConversationChat.cancelAttachment(item), record)}'''
if old_timeline not in source:
    raise SystemExit("timeline controller anchor not found")
source = source.replace(old_timeline, new_timeline, 1)

main.write_text(source, encoding="utf-8")
