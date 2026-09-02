import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocalGroups, type LocalGroup, type LocalIdentity, type PublicPeerIdentity } from "./services/offline/social-storage";
import type { TransportEvents } from "@risk/rtc";

const runtime = vi.hoisted(() => ({
  transports: new Map<string, {
    peerId: string;
    remotes: Set<string>;
    openPeers: Set<string>;
    events: TransportEvents;
    closed: boolean;
  }>(),
  messages: [] as Array<{ id: string; content: string }>,
  appliedRevocations: [] as string[],
}));

vi.mock("./services/offline/social-storage", async () => {
  const actual = await vi.importActual<typeof import("./services/offline/social-storage")>("./services/offline/social-storage");
  return {
    ...actual,
    loadLocalGroups: vi.fn(async () => []),
    mergeLocalGroupManifest: vi.fn(async (group: LocalGroup) => group),
    updateKnownPeerProfile: vi.fn(async () => undefined),
    applyGroupRevocationCertificate: vi.fn(async (certificate: { targetPeerId: string }) => {
      runtime.appliedRevocations.push(certificate.targetPeerId);
      return true;
    }),
  };
});

vi.mock("@risk/rtc", () => ({
  MeshWebRTCTransport: class FakeMeshWebRTCTransport {
    private readonly entry: {
      peerId: string;
      remotes: Set<string>;
      openPeers: Set<string>;
      events: TransportEvents;
      closed: boolean;
    };

    constructor(peerId: string, _iceServers: RTCIceServer[], events: TransportEvents) {
      this.entry = { peerId, remotes: new Set(), openPeers: new Set(), events, closed: false };
      runtime.transports.set(peerId, this.entry);
    }

    async connect(remotePeerId: string): Promise<void> {
      this.entry.remotes.add(remotePeerId);
      const remote = runtime.transports.get(remotePeerId);
      if (remote?.remotes.has(this.entry.peerId) && !remote.closed && !this.entry.openPeers.has(remotePeerId)) {
        this.entry.openPeers.add(remotePeerId);
        remote.openPeers.add(this.entry.peerId);
        queueMicrotask(() => {
          this.entry.events.onDataState?.(remotePeerId, "open");
          remote.events.onDataState?.(this.entry.peerId, "open");
        });
      }
    }

    async acceptOffer(): Promise<void> {}
    async acceptAnswer(): Promise<void> {}
    async addIceCandidate(): Promise<void> {}

    sendData(data: string, targetPeerId?: string): number {
      const targets = targetPeerId ? [targetPeerId] : [...this.entry.openPeers];
      let sent = 0;
      for (const remotePeerId of targets) {
        const remote = runtime.transports.get(remotePeerId);
        if (!remote || remote.closed || !this.entry.openPeers.has(remotePeerId)) continue;
        queueMicrotask(() => remote.events.onDataMessage?.(this.entry.peerId, data));
        sent += 1;
      }
      return sent;
    }

    async disconnect(remotePeerId?: string): Promise<void> {
      if (remotePeerId) {
        this.entry.remotes.delete(remotePeerId);
        this.entry.openPeers.delete(remotePeerId);
        return;
      }
      this.entry.closed = true;
      runtime.transports.delete(this.entry.peerId);
    }
  },
}));

vi.mock("./services/attachments/attachment-service", () => ({
  AttachmentService: class FakeAttachmentService extends EventTarget {
    async history(): Promise<never[]> { return []; }
    async peerReady(): Promise<void> {}
    forgetPeer(): void {}
    async handleControlString(): Promise<boolean> { return false; }
  },
}));

vi.mock("./services/attachments/desktop-storage", () => ({
  createAttachmentStorage: vi.fn(async () => ({})),
}));

vi.mock("./services/offline/chat-storage", () => ({
  loadLocalMessages: vi.fn(async () => []),
  saveLocalMessage: vi.fn(async (message: { id: string; content: string }) => {
    runtime.messages.push(message);
  }),
}));

import { ChatController, type ChatConnectionStatus } from "./chat";
import { InMemorySignalingHub, InMemorySignalingProvider } from "./services/signaling/in-memory";

async function identity(displayName: string): Promise<LocalIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    id: "self",
    peerId: crypto.randomUUID(),
    displayName,
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: pair.privateKey,
  };
}

function publicIdentity(value: LocalIdentity): PublicPeerIdentity {
  return {
    peerId: value.peerId,
    publicKey: value.publicKey,
    displayName: value.displayName,
  };
}

describe("ciclo de conexão do ChatController", () => {
  beforeEach(() => {
    runtime.transports.clear();
    runtime.messages.length = 0;
    runtime.appliedRevocations.length = 0;
    vi.mocked(loadLocalGroups).mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continua aguardando sem transformar ausência de peer em erro", async () => {
    vi.useFakeTimers();
    const hub = new InMemorySignalingHub();
    const local = await identity("Ana");
    const remote = await identity("Beto");
    const chat = new ChatController(() => new InMemorySignalingProvider(hub));
    const statuses: ChatConnectionStatus[] = [];
    chat.onStatus((status) => statuses.push(status));

    await chat.connect("canal-espera", local.displayName, [], {
      identity: local,
      trustedPeers: [publicIdentity(remote)],
      namespace: "friend",
    });
    await vi.advanceTimersByTimeAsync(15_100);

    expect(statuses.at(-1)).toBe("connected");
    expect(statuses).not.toContain("error");
    await chat.disconnect();
  });

  it("autentica dois peers e entrega mensagens sem atualização de página", async () => {
    const hub = new InMemorySignalingHub();
    const ana = await identity("Ana");
    const beto = await identity("Beto");
    const first = new ChatController(() => new InMemorySignalingProvider(hub));
    const second = new ChatController(() => new InMemorySignalingProvider(hub));
    const firstStatuses: ChatConnectionStatus[] = [];
    const secondStatuses: ChatConnectionStatus[] = [];
    const received: string[] = [];
    first.onStatus((status) => firstStatuses.push(status));
    second.onStatus((status) => secondStatuses.push(status));
    second.onMessage((message) => received.push(message.content));

    await first.connect("canal-tempo-real", ana.displayName, [], {
      identity: ana,
      trustedPeers: [publicIdentity(beto)],
      namespace: "friend",
    });
    await second.connect("canal-tempo-real", beto.displayName, [], {
      identity: beto,
      trustedPeers: [publicIdentity(ana)],
      namespace: "friend",
    });

    await vi.waitFor(() => {
      expect(firstStatuses.at(-1)).toBe("ready");
      expect(secondStatuses.at(-1)).toBe("ready");
    });
    await first.send("Olá em tempo real");
    await vi.waitFor(() => expect(received).toEqual(["Olá em tempo real"]));
    expect(runtime.messages).toHaveLength(2);

    await Promise.all([first.disconnect(), second.disconnect()]);
  });

  it("forma uma malha autenticada completa entre A, B e C", async () => {
    const hub = new InMemorySignalingHub();
    const a = await identity("Alice");
    const b = await identity("Bruno");
    const c = await identity("Carla");
    const group: LocalGroup = {
      groupId: "group_mesh_abc_12345678",
      name: "Grupo ABC",
      channels: [],
      members: [a, b, c].map(publicIdentity).sort((left, right) => left.peerId.localeCompare(right.peerId)),
      ownerPeerId: a.peerId,
      membershipVersion: 3,
      manifestVersion: 3,
      manifestActorPeerId: a.peerId,
      manifestOperationId: "operation_mesh_abc_12345678",
      administratorEpoch: 1,
      administratorPeerIds: [],
      administratorGrants: [],
      removedPeerIds: [],
      removedMembers: [],
      revocations: [],
      rendezvousVersion: 1,
      rendezvousSecret: "rendezvous_mesh_abc_12345678",
      joinedAt: Date.now(),
    };
    vi.mocked(loadLocalGroups).mockResolvedValue([group]);
    const controllers = [a, b, c].map(() => new ChatController(() => new InMemorySignalingProvider(hub)));
    const receivedByA: string[] = [];
    const receivedByC: string[] = [];
    controllers[0]!.onMessage((message) => receivedByA.push(message.content));
    controllers[2]!.onMessage((message) => receivedByC.push(message.content));
    const options = (local: LocalIdentity) => ({
      identity: local,
      trustedPeers: group.members,
      groupId: group.groupId,
      rendezvousId: group.groupId,
      namespace: "group" as const,
      requireIdentityAuthentication: true,
      membershipOnly: true,
    });

    await controllers[0]!.connect(group.groupId, a.displayName, [], options(a));
    await controllers[1]!.connect(group.groupId, b.displayName, [], options(b));
    await controllers[2]!.connect(group.groupId, c.displayName, [], options(c));

    await vi.waitFor(() => {
      for (const controller of controllers) {
        expect((controller as unknown as { openDataPeers: Set<string> }).openDataPeers.size).toBe(2);
      }
    });
    await controllers[1]!.send("B alcança A e C");
    await vi.waitFor(() => {
      expect(receivedByA).toEqual(["B alcança A e C"]);
      expect(receivedByC).toEqual(["B alcança A e C"]);
    });

    await Promise.all(controllers.map((controller) => controller.disconnect()));
  });

  it("preserva a transmissão de membros pedida durante uma atualização em andamento", async () => {
    const local = await identity("Dona do grupo");
    const remote = await identity("Membro antigo");
    const group: LocalGroup = {
      groupId: "group_members_refresh_12345678",
      name: "Grupo local",
      channels: [{ id: "channel_members_refresh_12345678", name: "geral", kind: "text" }],
      members: [publicIdentity(local), publicIdentity(remote)],
      ownerPeerId: local.peerId,
      membershipVersion: 2,
      manifestVersion: 2,
      manifestActorPeerId: local.peerId,
      manifestOperationId: crypto.randomUUID(),
      administratorPeerIds: [],
      removedPeerIds: [],
      removedMembers: [],
      joinedAt: Date.now(),
    };
    let releaseFirstLoad!: (groups: LocalGroup[]) => void;
    vi.mocked(loadLocalGroups)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirstLoad = resolve; }))
      .mockResolvedValue([group]);

    const controller = new ChatController();
    const internals = controller as unknown as {
      sessionToken: object;
      groupId: string;
      channelId: string;
      identity: LocalIdentity;
      openDataPeers: Set<string>;
      refreshGroupMembership(broadcast: boolean): Promise<void>;
      sendGroupMembership(remotePeerId: string): Promise<void>;
    };
    internals.sessionToken = {};
    internals.groupId = group.groupId;
    internals.channelId = group.channels[0]!.id;
    internals.identity = local;
    internals.openDataPeers.add(remote.peerId);
    const sendMembership = vi.spyOn(internals, "sendGroupMembership").mockResolvedValue();

    const initialRefresh = internals.refreshGroupMembership(false);
    await vi.waitFor(() => expect(loadLocalGroups).toHaveBeenCalledTimes(1));
    const broadcastRefresh = internals.refreshGroupMembership(true);
    releaseFirstLoad([group]);
    await Promise.all([initialRefresh, broadcastRefresh]);

    expect(loadLocalGroups).toHaveBeenCalledTimes(2);
    expect(sendMembership).toHaveBeenCalledOnce();
    expect(sendMembership).toHaveBeenCalledWith(remote.peerId);
  });

  it("recusa um peer de versão antiga antes de autenticar o DataChannel", async () => {
    const hub = new InMemorySignalingHub();
    const currentIdentity = await identity("Atual");
    const oldIdentity = await identity("Antigo");
    const current = new ChatController(() => new InMemorySignalingProvider(hub));
    const old = new ChatController(() => new InMemorySignalingProvider(hub, "0.1.0"));
    const statuses: ChatConnectionStatus[] = [];
    current.onStatus((status) => statuses.push(status));

    await current.connect("canal-versao", currentIdentity.displayName, [], {
      identity: currentIdentity,
      trustedPeers: [publicIdentity(oldIdentity)],
      namespace: "friend",
    });
    await old.connect("canal-versao", oldIdentity.displayName, [], {
      identity: oldIdentity,
      trustedPeers: [publicIdentity(currentIdentity)],
      namespace: "friend",
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("incompatible"));
    expect(runtime.messages).toEqual([]);
    await Promise.all([current.disconnect(), old.disconnect()]);
  });

  it("entrega a revogação ao removido sem liberar mensagens, histórico ou anexos", async () => {
    const hub = new InMemorySignalingHub();
    const member = await identity("Membro ativo");
    const removed = await identity("Membro removido");
    const groupId = "group_revocation_12345678";
    const certificate = {
      version: 1 as const,
      groupId,
      targetPeerId: removed.peerId,
      targetPublicKey: removed.publicKey,
      issuerPeerId: member.peerId,
      membershipVersion: 2,
      administratorEpoch: 1,
      messageId: crypto.randomUUID(),
      timestamp: Date.now(),
      signature: "A".repeat(86),
    };
    const activeChat = new ChatController(() => new InMemorySignalingProvider(hub));
    const removedChat = new ChatController(() => new InMemorySignalingProvider(hub));
    const removedStatuses: ChatConnectionStatus[] = [];
    const received: string[] = [];
    removedChat.onStatus((status) => removedStatuses.push(status));
    removedChat.onMessage((message) => received.push(message.content));

    await activeChat.connect("channel_revocation_12345678", member.displayName, [], {
      identity: member,
      trustedPeers: [],
      revokedPeers: [publicIdentity(removed)],
      revocations: [certificate],
      groupId,
      requireIdentityAuthentication: true,
    });
    await removedChat.connect("channel_revocation_12345678", removed.displayName, [], {
      identity: removed,
      trustedPeers: [publicIdentity(member)],
      groupId,
      requireIdentityAuthentication: true,
    });

    await vi.waitFor(() => expect(runtime.appliedRevocations).toEqual([removed.peerId]));
    await vi.waitFor(() => expect(removedStatuses.at(-1)).toBe("disconnected"));
    await activeChat.send("mensagem posterior à remoção");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
    expect(runtime.messages.filter((message) => message.content === "mensagem posterior à remoção")).toHaveLength(1);
    await activeChat.disconnect();
  });
});
