import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PeerState } from "@risk/protocol";
import type { LocalGroup } from "./services/offline/social-storage";

const callRuntime = vi.hoisted(() => ({ groups: [] as LocalGroup[] }));

vi.mock("./services/offline/social-storage", async () => {
  const actual = await vi.importActual<typeof import("./services/offline/social-storage")>("./services/offline/social-storage");
  return { ...actual, loadLocalGroups: vi.fn(async () => callRuntime.groups) };
});

type ReconcileRemoteMediaState = typeof import("./call")["reconcileRemoteMediaState"];
let reconcileRemoteMediaState: ReconcileRemoteMediaState;
let parseCallProfileMessage: typeof import("./call")["parseCallProfileMessage"];
let sameCallPublicKey: typeof import("./call")["sameCallPublicKey"];
let CallController: typeof import("./call")["CallController"];

function fakeStream(id: string, video = true): MediaStream {
  return {
    id,
    getVideoTracks: () => video ? [{} as MediaStreamTrack] : [],
  } as unknown as MediaStream;
}

beforeAll(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  });
  vi.stubGlobal("MediaStream", class {
    getTracks(): MediaStreamTrack[] { return []; }
  });
  ({ CallController, reconcileRemoteMediaState, parseCallProfileMessage, sameCallPublicKey } = await import("./call"));
});

afterAll(() => vi.unstubAllGlobals());

describe("reconcileRemoteMediaState", () => {
  it("mapeia screen share quando o MediaStream.id remoto difere do id anunciado", () => {
    const screen = fakeStream("firefox-screen-stream");
    const state: PeerState = {
      microphone: true,
      camera: false,
      screenShare: true,
      screenAudio: true,
      screenStreamId: "chromium-screen-stream",
    };

    const result = reconcileRemoteMediaState({ [screen.id]: screen }, state);
    expect(result.screenStreamId).toBe(screen.id);
  });

  it("distingue câmera e tela quando ambos estão ativos", () => {
    const camera = fakeStream("remote-main-stream");
    const screen = fakeStream("remote-screen-stream");
    const state: PeerState = {
      microphone: true,
      camera: true,
      screenShare: true,
      cameraStreamId: "sender-main-stream",
      screenStreamId: "sender-screen-stream",
    };

    const result = reconcileRemoteMediaState(
      { [camera.id]: camera, [screen.id]: screen },
      state,
    );
    expect(result.cameraStreamId).toBe(camera.id);
    expect(result.screenStreamId).toBe(screen.id);
  });
});

describe("perfil da chamada via DataChannel", () => {
  it("reconhece a mesma chave pública independentemente da ordem dos campos", () => {
    const stored: JsonWebKey = { kty: "EC", crv: "P-256", x: "abc", y: "def", ext: true, key_ops: ["verify"] };
    const received: JsonWebKey = { key_ops: ["verify"], y: "def", x: "abc", crv: "P-256", kty: "EC", ext: true };
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(received));
    expect(sameCallPublicKey(stored, received)).toBe(true);
  });

  it("aceita nome e avatar de imagem com envelope válido", () => {
    const avatar = "data:image/png;base64,AA==";
    expect(parseCallProfileMessage(JSON.stringify({
      version: 1,
      type: "call.profile",
      payload: { displayName: "Maria", avatar },
    }))).toEqual({ version: 1, type: "call.profile", payload: { displayName: "Maria", avatar } });
  });

  it("recusa URLs externas, SVG e payload excessivo", () => {
    for (const avatar of ["https://example.com/avatar.png", "data:image/svg+xml;base64,PHN2Zz4="]) {
      expect(parseCallProfileMessage(JSON.stringify({ version: 1, type: "call.profile", payload: { displayName: "Maria", avatar } }))).toBeNull();
    }
    expect(parseCallProfileMessage(JSON.stringify({
      version: 1,
      type: "call.profile",
      payload: { displayName: "Maria", avatar: `data:image/png;base64,${"A".repeat(70_000)}` },
    }))).toBeNull();
  });
});

describe("sincronização de membros durante a chamada", () => {
  it("conecta peers presentes que se tornaram confiáveis após atualizar o grupo", async () => {
    const localPeerId = "00000000-0000-4000-8000-000000000001";
    const peerB = "00000000-0000-4000-8000-000000000002";
    const peerC = "00000000-0000-4000-8000-000000000003";
    const groupId = "group_call_members_12345678";
    const roomId = "room_call_members_12345678";
    callRuntime.groups = [{
      groupId,
      name: "Grupo da chamada",
      channels: [],
      members: [localPeerId, peerB, peerC].map((peerId) => ({ peerId, displayName: peerId, publicKey: { kty: "EC" } })),
      ownerPeerId: localPeerId,
      membershipVersion: 3,
      manifestVersion: 3,
      administratorPeerIds: [],
      removedPeerIds: [],
      removedMembers: [],
      joinedAt: Date.now(),
    }];
    const connect = vi.fn(async () => undefined);
    const reconnectSignaling = vi.fn(async () => undefined);
    const sendPeerState = vi.fn(async () => undefined);
    const signaling = {
      connect: reconnectSignaling,
      getDiagnostics: () => ({ presencePeers: [peerB, peerC] }),
      sendPeerState,
    };
    const controller = new CallController();
    const internals = controller as unknown as {
      lifecycleId: number;
      roomId: string;
      rendezvousId: string;
      groupId: string;
      peerId: string;
      signaling: typeof signaling;
      transport: { connect: typeof connect };
      refreshGroupSecurity(): Promise<void>;
    };
    internals.lifecycleId = 1;
    internals.roomId = roomId;
    internals.rendezvousId = roomId;
    internals.groupId = groupId;
    internals.peerId = localPeerId;
    internals.signaling = signaling;
    internals.transport = { connect };

    await internals.refreshGroupSecurity();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith(peerB, true);
    expect(connect).toHaveBeenCalledWith(peerC, true);
    expect(sendPeerState).toHaveBeenCalledOnce();
  });
});
