import { beforeEach, describe, expect, it, vi } from "vitest";
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
