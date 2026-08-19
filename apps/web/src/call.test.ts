import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PeerState } from "@risk/protocol";

type ReconcileRemoteMediaState = typeof import("./call")["reconcileRemoteMediaState"];
let reconcileRemoteMediaState: ReconcileRemoteMediaState;

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
  ({ reconcileRemoteMediaState } = await import("./call"));
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
