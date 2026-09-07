import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalGroup } from "../offline/social-storage";

const runtime = vi.hoisted(() => ({
  connected: [] as string[],
  membershipConnected: [] as string[],
  membershipRendezvousIds: [] as string[],
  disconnected: [] as string[],
  failedOnce: new Set<string>(),
  connectAttempts: new Map<string, number>(),
}));

vi.mock("../offline/social-storage", async () => {
  const actual = await vi.importActual<typeof import("../offline/social-storage")>("../offline/social-storage");
  return {
    ...actual,
    getOrCreateLocalIdentity: vi.fn(async (displayName: string) => ({
      id: "self" as const,
      peerId: "owner-background-test",
      displayName,
      publicKey: { kty: "EC", crv: "P-256", x: "owner-x", y: "owner-y" },
      privateKey: {} as CryptoKey,
    })),
  };
});

vi.mock("../../chat", () => ({
  ChatController: class FakeChatController {
    private channelId?: string;
    private membershipOnly = false;
    private readonly statusListeners = new Set<(status: string) => void>();

    onMessage(): () => void { return () => undefined; }
    onStatus(listener: (status: string) => void): () => void {
      this.statusListeners.add(listener);
      return () => this.statusListeners.delete(listener);
    }

    async connect(channelId: string, _displayName?: string, _iceServers?: RTCIceServer[], options?: { membershipOnly?: boolean; rendezvousId?: string }): Promise<void> {
      this.channelId = channelId;
      this.membershipOnly = options?.membershipOnly === true;
      runtime.connectAttempts.set(channelId, (runtime.connectAttempts.get(channelId) ?? 0) + 1);
      if (runtime.failedOnce.delete(channelId)) throw new Error("falha temporária");
      if (this.membershipOnly) {
        runtime.membershipConnected.push(channelId);
        runtime.membershipRendezvousIds.push(options?.rendezvousId ?? "");
      } else runtime.connected.push(channelId);
      this.statusListeners.forEach((listener) => listener("connected"));
      this.statusListeners.forEach((listener) => listener("ready"));
    }

    async disconnect(): Promise<void> {
      if (this.channelId && !this.membershipOnly) runtime.disconnected.push(this.channelId);
      this.channelId = undefined;
      this.statusListeners.forEach((listener) => listener("disconnected"));
    }
  },
}));

import {
  BackgroundChatManager,
  MAX_BACKGROUND_MEMBERSHIP_GROUPS,
  MAX_BACKGROUND_PRIVATE_CHATS,
} from "./background-manager";

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
    runtime.membershipConnected.length = 0;
    runtime.membershipRendezvousIds.length = 0;
    runtime.disconnected.length = 0;
    runtime.failedOnce.clear();
    runtime.connectAttempts.clear();
  });

  it("não ocupa o canal ativo nem o canal reservado pela chamada", async () => {
    const manager = new BackgroundChatManager();
    const group = groupWithTextChannels("foreground", "call-chat", "background");
    await manager.sync([group], "Ana", [], "foreground", ["call-chat"]);
    expect(runtime.connected).toEqual(["background"]);
    expect(runtime.membershipConnected).toEqual([group.groupId]);
    expect(runtime.disconnected).toEqual([]);
    await manager.disconnect();
  });

  it("mantém sincronização de membros mesmo quando o grupo não possui canal de texto", async () => {
    const manager = new BackgroundChatManager();
    const group = groupWithTextChannels();
    await manager.sync([group], "Ana", []);
    expect(runtime.connected).toEqual([]);
    expect(runtime.membershipConnected).toEqual([group.groupId]);
    await manager.disconnect();
  });

  it("mantém o rendezvous de membros estável quando o segredo privado gira", async () => {
    const manager = new BackgroundChatManager();
    const before = groupWithTextChannels();
    await manager.sync([before], "Ana", []);
    const firstRendezvous = runtime.membershipRendezvousIds[0];
    await manager.disconnect();

    const after = { ...before, rendezvousVersion: 2, rendezvousSecret: "B".repeat(43) };
    const nextManager = new BackgroundChatManager();
    await nextManager.sync([after], "Ana", []);

    expect(runtime.membershipRendezvousIds.at(-1)).toBe(firstRendezvous);
    expect(firstRendezvous).toContain(before.groupId);
    await nextManager.disconnect();
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

  it("limits membership sessions and reports the groups waiting for capacity", async () => {
    const manager = new BackgroundChatManager();
    const groups = Array.from({ length: MAX_BACKGROUND_MEMBERSHIP_GROUPS + 2 }, (_, index) => ({
      ...groupWithTextChannels(),
      groupId: `group_background_${String(index).padStart(8, "0")}`,
    }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.sync(groups, "Ana", []);

    expect(runtime.membershipConnected).toHaveLength(MAX_BACKGROUND_MEMBERSHIP_GROUPS);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("2 grupos aguardam uma vaga"));
    warning.mockRestore();
    await manager.disconnect();
  });

  it("retries a transient background connection failure", async () => {
    vi.useFakeTimers();
    const manager = new BackgroundChatManager();
    runtime.failedOnce.add("background-retry");

    await manager.sync([groupWithTextChannels("background-retry")], "Ana", []);
    expect(runtime.connectAttempts.get("background-retry")).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(runtime.connectAttempts.get("background-retry")).toBe(2);
    expect(runtime.connected).toContain("background-retry");
    await manager.disconnect();
    vi.useRealTimers();
  });
});
