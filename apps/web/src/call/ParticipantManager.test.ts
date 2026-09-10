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
