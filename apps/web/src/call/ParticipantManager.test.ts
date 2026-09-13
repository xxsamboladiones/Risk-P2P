import { beforeEach, describe, expect, it } from "vitest";
import { useCallStore } from "../store";
import { ParticipantManager } from "./ParticipantManager";

class FakeTrack extends EventTarget {
  readonly kind = "video";
  readyState: MediaStreamTrackState = "live";

  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

function screenStream(id: string, track: FakeTrack): MediaStream {
  return {
    id,
    getTracks: () => [track as unknown as MediaStreamTrack],
    getVideoTracks: () => [track as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
}

beforeEach(() => useCallStore.getState().reset());

describe("ParticipantManager", () => {
  it.each(["state-first", "stream-first"])("mostra uma tela já ativa para quem entra depois (%s)", (order) => {
    const manager = new ParticipantManager();
    const stream = screenStream("received-screen", new FakeTrack());
    const state = { microphone: true, camera: false, screenShare: true, screenStreamId: "announced-screen" };
    manager.ensure("peer");
    if (order === "state-first") manager.state("peer", state);
    manager.remoteStream("peer", stream);
    manager.state("peer", state);
    const participant = useCallStore.getState().participants.peer!;
    expect(participant.streams?.[participant.state.screenStreamId!]).toBe(stream);
  });

  it("associa câmera e tela já recebidas ao primeiro estado da chamada", () => {
    const manager = new ParticipantManager();
    const camera = screenStream("received-camera", new FakeTrack());
    const screen = screenStream("received-screen", new FakeTrack());
    manager.remoteStream("peer", camera);
    manager.remoteStream("peer", screen);
    manager.state("peer", {
      microphone: true, camera: true, screenShare: true,
      cameraStreamId: "announced-camera", screenStreamId: "announced-screen",
    });
    const participant = useCallStore.getState().participants.peer!;
    expect(participant.streams?.[participant.state.screenStreamId!]).toBe(screen);
    expect(participant.streams?.[participant.state.cameraStreamId!]).toBe(camera);
  });

  it("preserva o novo ID anunciado, remove a tela encerrada e aceita a substituta", () => {
    const manager = new ParticipantManager();
    const oldTrack = new FakeTrack();
    const oldStream = screenStream("screen-old", oldTrack);
    const newStream = screenStream("screen-new", new FakeTrack());
    useCallStore.getState().upsert({
      peerId: "peer",
      displayName: "Peer",
      state: {
        microphone: true,
        camera: false,
        screenShare: true,
        screenStreamId: "sender-screen-old",
      },
      streams: {},
    });

    manager.remoteStream("peer", oldStream);
    expect(useCallStore.getState().participants.peer?.state.screenStreamId).toBe("screen-old");

    manager.state("peer", {
      microphone: true,
      camera: false,
      screenShare: true,
      screenStreamId: "sender-screen-new",
    });
    expect(useCallStore.getState().participants.peer?.state.screenStreamId).toBe("sender-screen-new");
    manager.state("peer", {
      microphone: true,
      camera: false,
      screenShare: true,
      screenStreamId: "sender-screen-new",
    });
    expect(useCallStore.getState().participants.peer?.state.screenStreamId).toBe("sender-screen-new");

    manager.remoteStream("peer", newStream);
    expect(useCallStore.getState().participants.peer?.state.screenStreamId).toBe("screen-new");

    oldTrack.end();
    expect(useCallStore.getState().participants.peer?.streams).toEqual({ "screen-new": newStream });
  });
});
