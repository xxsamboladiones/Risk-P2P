import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalGroup } from "../offline/social-storage";

const runtime = vi.hoisted(() => ({
  connected: [] as string[],
  disconnected: [] as string[],
}));

vi.mock("../../chat", () => ({
  ChatController: class FakeChatController {
    private channelId?: string;

    onMessage(): () => void { return () => undefined; }

    async connect(channelId: string): Promise<void> {
      this.channelId = channelId;
      runtime.connected.push(channelId);
    }

    async disconnect(): Promise<void> {
      if (this.channelId) runtime.disconnected.push(this.channelId);
      this.channelId = undefined;
    }
  },
}));

import { BackgroundChatManager } from "./background-manager";

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

  it("libera uma sessão já aberta quando a chamada assume o canal", async () => {
    const manager = new BackgroundChatManager();
    const group = groupWithTextChannels("call-chat");

    await manager.sync([group], "Ana", []);
    expect(runtime.connected).toEqual(["call-chat"]);

    await manager.release("call-chat");
    expect(runtime.disconnected).toEqual(["call-chat"]);

    await manager.sync([group], "Ana", [], undefined, ["call-chat"]);
    expect(runtime.connected).toEqual(["call-chat"]);
  });
});
