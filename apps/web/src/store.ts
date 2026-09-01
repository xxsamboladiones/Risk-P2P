import { create } from "zustand";
import type { PeerState } from "@risk/protocol";

export type Participant = { peerId: string; displayName: string; avatar?: string; state: PeerState; streams?: Record<string, MediaStream>; connection?: RTCPeerConnectionState };
export type CallContext = {
  groupId: string;
  groupName: string;
  voiceChannelId: string | null;
  voiceChannelName: string | null;
  textChannelId: string | null;
  textChannelName: string | null;
  displayName: string;
  avatar?: string;
};
export type LocalMediaPreviews = {
  microphone: MediaStream | null;
  camera: MediaStream | null;
  screen: MediaStream | null;
};

type CallState = {
  token: string | null; roomId: string | null; callContext: CallContext | null; callWorkspaceOpen: boolean; selfPeerId: string | null; participants: Record<string, Participant>; localPreviews: LocalMediaPreviews; localState: PeerState; error: string | null;
  setSession(token: string): void; setRoom(roomId: string | null): void; setCallContext(context: CallContext | null): void; setCallWorkspaceOpen(open: boolean): void; setSelf(peerId: string | null): void;
  setLocalMedia(previews: LocalMediaPreviews, state: PeerState): void; upsert(participant: Participant): void; remove(peerId: string): void; clearParticipants(): void; setError(error: string | null): void; reset(): void;
};
export const useCallStore = create<CallState>((set) => ({
  token: sessionStorage.getItem("accessToken"), roomId: null, callContext: null, callWorkspaceOpen: false, selfPeerId: null, participants: {}, localPreviews: { microphone: null, camera: null, screen: null }, localState: { microphone: true, camera: false, screenShare: false }, error: null,
  setSession: (token) => { sessionStorage.setItem("accessToken", token); set({ token, error: null }); },
  setRoom: (roomId) => set({ roomId, callWorkspaceOpen: Boolean(roomId) }), setCallContext: (callContext) => set({ callContext }), setCallWorkspaceOpen: (callWorkspaceOpen) => set({ callWorkspaceOpen }), setSelf: (selfPeerId) => set({ selfPeerId }),
  setLocalMedia: (localPreviews, localState) => set({ localPreviews, localState: { ...localState } }),
  upsert: (participant) => set((state) => ({ participants: { ...state.participants, [participant.peerId]: { ...state.participants[participant.peerId], ...participant } } })),
  remove: (peerId) => set((state) => { const participants = { ...state.participants }; delete participants[peerId]; return { participants }; }),
  clearParticipants: () => set({ participants: {}, selfPeerId: null }),
  setError: (error) => set({ error }),
  reset: () => {
    sessionStorage.removeItem("accessToken");
    set({ token: null, roomId: null, callContext: null, callWorkspaceOpen: false, selfPeerId: null, participants: {}, localPreviews: { microphone: null, camera: null, screen: null }, localState: { microphone: true, camera: false, screenShare: false }, error: null });
  },
}));
