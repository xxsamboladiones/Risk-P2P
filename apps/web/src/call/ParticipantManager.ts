import type { PeerState } from "@risk/protocol";
import { useCallStore, type Participant } from "../store";
import { validAvatarDataUrl } from "../services/offline/profile";

export type CallProfileMessage = {
  version: 1;
  type: "call.profile";
  payload: { displayName: string; avatar?: string };
};

export function parseCallProfileMessage(value: string): CallProfileMessage | null {
  if (new TextEncoder().encode(value).byteLength > 64 * 1024) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== 1 || envelope.type !== "call.profile" || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) return null;
  const payload = envelope.payload as Record<string, unknown>;
  const displayName = typeof payload.displayName === "string" ? payload.displayName.trim() : "";
  if (displayName.length < 2 || displayName.length > 80) return null;
  if (payload.avatar !== undefined && !validAvatarDataUrl(payload.avatar)) return null;
  return { version: 1, type: "call.profile", payload: { displayName, avatar: payload.avatar as string | undefined } };
}

export function placeholderParticipant(peerId: string): Participant {
  return {
    peerId,
    displayName: `Peer ${peerId.slice(0, 6)}`,
    state: { microphone: true, camera: false, screenShare: false },
    streams: {},
    connection: "new",
  };
}

export function reconcileRemoteMediaState(
  streamsById: Participant["streams"],
  state: PeerState,
): PeerState {
  const streams = Object.values(streamsById ?? {});
  const videoStreams = streams.filter((stream) => stream.getVideoTracks().length > 0);
  if (!videoStreams.length) return state;

  const next = { ...state };
  const exactCamera = next.cameraStreamId ? streamsById?.[next.cameraStreamId] : undefined;
  const exactScreen = next.screenStreamId ? streamsById?.[next.screenStreamId] : undefined;

  // O msid/MediaStream.id pode mudar entre Firefox e Chromium. Quando não há
  // correspondência exata, o stream principal é tratado como câmera e o último
  // stream de vídeo publicado como compartilhamento de tela.
  if (next.screenShare && !exactScreen) {
    let candidate: MediaStream | undefined;
    if (exactCamera) candidate = [...videoStreams].reverse().find((stream) => stream.id !== exactCamera.id);
    else if (!next.camera || videoStreams.length >= 2) candidate = videoStreams.at(-1);
    if (candidate) next.screenStreamId = candidate.id;
  }

  const normalizedScreen = next.screenStreamId ? streamsById?.[next.screenStreamId] : undefined;
  if (next.camera && !exactCamera) {
    let candidate: MediaStream | undefined;
    if (normalizedScreen) candidate = videoStreams.find((stream) => stream.id !== normalizedScreen.id);
    else if (!next.screenShare || videoStreams.length >= 2) candidate = videoStreams[0];
    if (candidate) next.cameraStreamId = candidate.id;
  }
  return next;
}

export class ParticipantManager {
  private readonly announcedScreenStreamIds = new Map<string, string>();
  private readonly announcedCameraStreamIds = new Map<string, string>();
  private readonly pendingScreenStreamIds = new Map<string, string>();
  private readonly pendingCameraStreamIds = new Map<string, string>();

  remoteStream(peerId: string, stream: MediaStream): void {
    const store = useCallStore.getState();
    const participant = store.participants[peerId] ?? placeholderParticipant(peerId);
    const streams = Object.fromEntries(Object.entries(participant.streams ?? {})
      .filter(([, current]) => hasLiveRemoteMedia(current)));
    streams[stream.id] = stream;
    const state = reconcileRemoteMediaState(streams, participant.state);
    store.upsert({ ...participant, streams, state });
    if (state.screenStreamId === stream.id) this.pendingScreenStreamIds.delete(peerId);
    if (state.cameraStreamId === stream.id) this.pendingCameraStreamIds.delete(peerId);

    const removeEndedStream = () => {
      if (hasLiveRemoteMedia(stream)) return;
      const currentStore = useCallStore.getState();
      const current = currentStore.participants[peerId];
      if (!current || current.streams?.[stream.id] !== stream) return;
      const remaining = { ...current.streams };
      delete remaining[stream.id];
      currentStore.upsert({
        ...current,
        streams: remaining,
        state: reconcileRemoteMediaState(remaining, current.state),
      });
    };
    stream.getTracks().forEach((track) => track.addEventListener("ended", removeEndedStream));
  }

  connection(peerId: string, connection: RTCPeerConnectionState): void {
    const store = useCallStore.getState();
    const participant = store.participants[peerId] ?? placeholderParticipant(peerId);
    store.upsert({ ...participant, connection });
  }

  ensure(peerId: string): void {
    const store = useCallStore.getState();
    const participant = store.participants[peerId] ?? placeholderParticipant(peerId);
    store.upsert({ ...participant, connection: participant.connection ?? "new" });
  }

  profile(peerId: string, displayName: string, avatar?: string): void {
    const store = useCallStore.getState();
    const participant = store.participants[peerId] ?? placeholderParticipant(peerId);
    store.upsert({ ...participant, displayName, avatar });
  }

  state(peerId: string, remoteState: PeerState): void {
    const store = useCallStore.getState();
    const participant = store.participants[peerId] ?? placeholderParticipant(peerId);
    const streams = participant.streams ?? {};
    this.observeAnnouncedStreamId(
      peerId,
      remoteState.screenShare ? remoteState.screenStreamId : undefined,
      streams,
      this.announcedScreenStreamIds,
      this.pendingScreenStreamIds,
    );
    this.observeAnnouncedStreamId(
      peerId,
      remoteState.camera ? remoteState.cameraStreamId : undefined,
      streams,
      this.announcedCameraStreamIds,
      this.pendingCameraStreamIds,
    );
    const state = reconcileRemoteMediaState(streams, remoteState);
    // O estado costuma chegar antes do evento ontrack. Não substitua um ID
    // recém-anunciado pelo stream antigo enquanto a renegociação está em voo.
    const pendingScreenId = this.pendingScreenStreamIds.get(peerId);
    const pendingCameraId = this.pendingCameraStreamIds.get(peerId);
    if (pendingScreenId && remoteState.screenShare) state.screenStreamId = pendingScreenId;
    if (pendingCameraId && remoteState.camera) state.cameraStreamId = pendingCameraId;
    store.upsert({ ...participant, state });
  }

  private observeAnnouncedStreamId(
    peerId: string,
    announcedId: string | undefined,
    streams: Record<string, MediaStream>,
    announcedIds: Map<string, string>,
    pendingIds: Map<string, string>,
  ): void {
    if (!announcedId) {
      announcedIds.delete(peerId);
      pendingIds.delete(peerId);
      return;
    }
    if (announcedIds.get(peerId) === announcedId) return;
    announcedIds.set(peerId, announcedId);
    if (streams[announcedId]) pendingIds.delete(peerId);
    else pendingIds.set(peerId, announcedId);
  }

  reconnecting(peerId: string, clearStreams = false): void {
    const store = useCallStore.getState();
    const participant = store.participants[peerId] ?? placeholderParticipant(peerId);
    const streams = clearStreams ? {} : participant.streams;
    if (clearStreams) Object.values(participant.streams ?? {}).forEach((stream) => stream.getTracks().forEach((track) => { track.enabled = false; }));
    store.upsert({ ...participant, streams, connection: "connecting" });
  }

  remove(peerId: string): void {
    this.announcedScreenStreamIds.delete(peerId);
    this.announcedCameraStreamIds.delete(peerId);
    this.pendingScreenStreamIds.delete(peerId);
    this.pendingCameraStreamIds.delete(peerId);
    useCallStore.getState().remove(peerId);
  }

  clear(): void {
    this.announcedScreenStreamIds.clear();
    this.announcedCameraStreamIds.clear();
    this.pendingScreenStreamIds.clear();
    this.pendingCameraStreamIds.clear();
    useCallStore.getState().clearParticipants();
  }
}

function hasLiveRemoteMedia(stream: MediaStream): boolean {
  const videoTracks = stream.getVideoTracks();
  const relevantTracks = videoTracks.length ? videoTracks : stream.getTracks();
  return relevantTracks.some((track) => track.readyState !== "ended");
}
