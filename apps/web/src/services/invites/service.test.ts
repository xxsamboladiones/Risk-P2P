import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportEvents } from "@risk/rtc";
import { InMemorySignalingHub, InMemorySignalingProvider } from "../signaling/in-memory";
import type { LocalIdentity } from "../offline/social-storage";
import { FriendInviteService, GroupInviteService, type InviteDependencies, type InviteTransport } from "./service";

const savedFriends: unknown[] = []; const savedGroups: unknown[] = []; const members: unknown[] = [];
vi.mock("../offline/social-storage", async (original) => {
  const actual = await original<typeof import("../offline/social-storage")>();
  return { ...actual, saveLocalFriend: vi.fn(async (value) => { savedFriends.push(value); }), saveLocalGroup: vi.fn(async (value) => { savedGroups.push(value); }), addLocalGroupMember: vi.fn(async (...value) => { members.push(value); }) };
});

async function identity(name: string): Promise<LocalIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { id: "self", peerId: crypto.randomUUID(), displayName: name, publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: pair.privateKey };
}

class DataTransportHub {
  transports = new Map<string, FakeTransport>();
  create(peerId: string, events: TransportEvents): FakeTransport { const transport = new FakeTransport(peerId, events, this); this.transports.set(peerId, transport); return transport; }
}
class FakeTransport implements InviteTransport {
  remote?: string; closed = false; readonly dropTypes = new Set<string>();
  constructor(readonly peerId: string, readonly events: TransportEvents, private readonly hub: DataTransportHub) {}
  async connect(peerId: string): Promise<void> {
    this.remote = peerId;
    const other = this.hub.transports.get(peerId);
    if (other?.remote === this.peerId) queueMicrotask(() => { this.events.onDataState?.(peerId, "open"); other.events.onDataState?.(this.peerId, "open"); });
  }
  async acceptOffer(): Promise<void> {} async acceptAnswer(): Promise<void> {} async addIceCandidate(): Promise<void> {}
  sendData(data: string, targetPeerId?: string): number {
    const target = this.hub.transports.get(targetPeerId ?? this.remote ?? "");
    if (!target || target.closed) return 0;
    let type = "";
    try { type = String((JSON.parse(data) as { type?: unknown }).type ?? ""); } catch { /* invalid payload is delivered to parser */ }
    if (this.dropTypes.has(type)) return 1;
    queueMicrotask(() => target.events.onDataMessage?.(this.peerId, data));
    return 1;
  }
  async disconnect(peerId?: string): Promise<void> {
    if (peerId) {
      if (this.remote === peerId) this.remote = undefined;
      return;
    }
    this.closed = true;
    this.remote = undefined;
  }
}

function dependencies(signalingHub: InMemorySignalingHub, dataHub: DataTransportHub): InviteDependencies {
  return { createSignaling: () => new InMemorySignalingProvider(signalingHub), createTransport: (peerId, _ice, events) => dataHub.create(peerId, events), now: () => Date.now(), setTimer: (callback, delay) => setTimeout(callback, delay), clearTimer: (timer) => clearTimeout(timer) };
}

describe("convites P2P descartáveis", () => {
  beforeEach(() => { savedFriends.length = 0; savedGroups.length = 0; members.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it("conclui pedido e aceite de amizade pelo DataChannel e limpa o rendezvous", async () => {
    const signaling = new InMemorySignalingHub(); const data = new DataTransportHub(); const deps = dependencies(signaling, data);
    const creator = new FriendInviteService(await identity("Ana"), [], deps); const joiner = new FriendInviteService(await identity("Beto"), [], deps);
    let incoming = false; creator.onRequest(() => { incoming = true; });
    const invite = await creator.createFriendInvite(); await joiner.joinFriendInvite(invite.code);
    await vi.waitFor(() => expect(incoming).toBe(true)); await creator.accept();
    await vi.waitFor(() => expect(joiner.state?.status).toBe("accepted"));
    await vi.waitFor(() => expect(savedFriends).toHaveLength(2));
    const rendezvous = await import("./code").then(({ deriveInviteRendezvousId }) => deriveInviteRendezvousId("friend", invite.code));
    await vi.waitFor(() => expect(signaling.roomSize(`friend:${rendezvous}`)).toBe(0));
  });

  it("transmite grupo no aceite e permite recusar sem salvar", async () => {
    const signaling = new InMemorySignalingHub(); const data = new DataTransportHub(); const deps = dependencies(signaling, data);
    const owner = await identity("Admin");
    const creator = new GroupInviteService(owner, [], deps); const joiner = new GroupInviteService(await identity("Convidado"), [], deps);
    const group = { groupId: crypto.randomUUID(), name: "Jogatina", channels: [{ id: crypto.randomUUID(), name: "geral", kind: "text" as const }], ownerPeerId: owner.peerId, membershipVersion: 1, manifestVersion: 1, administratorPeerIds: [], removedPeerIds: [], removedMembers: [] };
    const invite = await creator.createGroupInvite(group); await joiner.joinGroupInvite(invite.code);
    await vi.waitFor(() => expect(creator.state?.status).toBe("approval")); await creator.accept();
    await vi.waitFor(() => expect(joiner.state?.status).toBe("accepted"));
    await vi.waitFor(() => expect(members).toHaveLength(1));
    expect(savedGroups).toHaveLength(1);
    const creator2 = new FriendInviteService(await identity("C"), [], deps); const joiner2 = new FriendInviteService(await identity("D"), [], deps);
    const second = await creator2.createFriendInvite(); await joiner2.joinFriendInvite(second.code); await vi.waitFor(() => expect(creator2.state?.status).toBe("approval")); await creator2.reject();
    await vi.waitFor(() => expect(joiner2.state?.status).toBe("rejected")); expect(savedFriends).toHaveLength(0);
  });

  it("não fica preso quando o DataChannel fecha depois de abrir", async () => {
    const signaling = new InMemorySignalingHub(); const data = new DataTransportHub(); const deps = dependencies(signaling, data);
    const creator = new FriendInviteService(await identity("Ana"), [], deps); const joiner = new FriendInviteService(await identity("Beto"), [], deps);
    const invite = await creator.createFriendInvite(); await joiner.joinFriendInvite(invite.code);
    await vi.waitFor(() => expect(creator.state?.status).toBe("approval"));
    const [creatorTransport, joinerTransport] = [...data.transports.values()];
    expect(creatorTransport && joinerTransport).toBeTruthy();
    creatorTransport!.events.onDataState?.(joinerTransport!.peerId, "closed");
    joinerTransport!.events.onDataState?.(creatorTransport!.peerId, "closed");
    await vi.waitFor(() => expect(joiner.state?.status).toBe("error"));
    expect(["waiting", "connecting"]).toContain(creator.state?.status);
    await creator.cancel(false);
  });

  it("volta para aprovação quando uma decisão não recebe confirmação", async () => {
    const signaling = new InMemorySignalingHub(); const data = new DataTransportHub(); const deps = dependencies(signaling, data);
    const creator = new FriendInviteService(await identity("Ana"), [], deps); const joiner = new FriendInviteService(await identity("Beto"), [], deps);
    const invite = await creator.createFriendInvite(); await joiner.joinFriendInvite(invite.code);
    await vi.waitFor(() => expect(creator.state?.status).toBe("approval"));
    const creatorTransport = [...data.transports.values()][0]!;
    creatorTransport.dropTypes.add("friend.accept");
    vi.useFakeTimers();
    await creator.accept();
    expect(creator.state?.status).toBe("confirming");
    await vi.advanceTimersByTimeAsync(15_100);
    expect(creator.state?.status).toBe("approval");
    expect(creator.state?.message).toContain("tentar novamente");
    vi.useRealTimers();
    await Promise.all([creator.cancel(false), joiner.cancel(false)]);
  });

  it("cancela e executa cleanup de signaling e transporte", async () => {
    const signaling = new InMemorySignalingHub(); const data = new DataTransportHub(); const deps = dependencies(signaling, data);
    const creator = new FriendInviteService(await identity("Ana"), [], deps); const invite = await creator.createFriendInvite();
    await creator.cancel(); expect(creator.state?.status).toBe("cancelled"); expect([...data.transports.values()].every((item) => item.closed)).toBe(true);
    const rendezvous = await import("./code").then(({ deriveInviteRendezvousId }) => deriveInviteRendezvousId("friend", invite.code)); expect(signaling.roomSize(`friend:${rendezvous}`)).toBe(0);
  });

  it("expira automaticamente e destrói o canal temporário", async () => {
    const signaling = new InMemorySignalingHub(); const data = new DataTransportHub(); const deps = dependencies(signaling, data);
    const creator = new FriendInviteService(await identity("Ana"), [], deps); const invite = await creator.createFriendInvite(20);
    await vi.waitFor(() => expect(creator.state?.status).toBe("expired"));
    const rendezvous = await import("./code").then(({ deriveInviteRendezvousId }) => deriveInviteRendezvousId("friend", invite.code)); expect(signaling.roomSize(`friend:${rendezvous}`)).toBe(0);
  });
});
