import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PeerState } from "@risk/protocol";

type ReconcileRemoteMediaState = typeof import("./call")["reconcileRemoteMediaState"];
let reconcileRemoteMediaState: ReconcileRemoteMediaState;
let parseCallProfileMessage: typeof import("./call")["parseCallProfileMessage"];

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
  ({ reconcileRemoteMediaState, parseCallProfileMessage } = await import("./call"));
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
