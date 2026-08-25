import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalIdentity, PublicPeerIdentity } from "./services/offline/social-storage";
import type { TransportEvents } from "@risk/rtc";

const runtime = vi.hoisted(() => ({
  transports: new Map<string, {
    peerId: string;
    remote?: string;
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
      remote?: string;
      events: TransportEvents;
      closed: boolean;
    };

    constructor(peerId: string, _iceServers: RTCIceServer[], events: TransportEvents) {
      this.entry = { peerId, events, closed: false };
      runtime.transports.set(peerId, this.entry);
    }

    async connect(remotePeerId: string): Promise<void> {
      this.entry.remote = remotePeerId;
      const remote = runtime.transports.get(remotePeerId);
      if (remote?.remote === this.entry.peerId && !remote.closed) {
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
      const remotePeerId = targetPeerId ?? this.entry.remote;
      const remote = remotePeerId ? runtime.transports.get(remotePeerId) : undefined;
      if (!remote || remote.closed) return 0;
      queueMicrotask(() => remote.events.onDataMessage?.(this.entry.peerId, data));
      return 1;
    }

    async disconnect(remotePeerId?: string): Promise<void> {
      if (remotePeerId) {
        if (this.entry.remote === remotePeerId) this.entry.remote = undefined;
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
