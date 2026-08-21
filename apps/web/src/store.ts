import { create } from "zustand";
import type { PeerState } from "@risk/protocol";

export type Participant = { peerId: string; displayName: string; state: PeerState; streams?: Record<string, MediaStream>; connection?: RTCPeerConnectionState };
export type CallContext = {
  groupId: string;
  groupName: string;
  textChannelId: string | null;
  textChannelName: string | null;
  displayName: string;
};

type CallState = {
  token: string | null; roomId: string | null; callContext: CallContext | null; selfPeerId: string | null; participants: Record<string, Participant>; localPreviews: { camera: MediaStream | null; screen: MediaStream | null }; localState: PeerState; error: string | null;
  setSession(token: string): void; setRoom(roomId: string | null): void; setCallContext(context: CallContext | null): void; setSelf(peerId: string | null): void;
  setLocalMedia(previews: { camera: MediaStream | null; screen: MediaStream | null }, state: PeerState): void; upsert(participant: Participant): void; remove(peerId: string): void; clearParticipants(): void; setError(error: string | null): void; reset(): void;
};
export const useCallStore = create<CallState>((set) => ({
  token: sessionStorage.getItem("accessToken"), roomId: null, callContext: null, selfPeerId: null, participants: {}, localPreviews: { camera: null, screen: null }, localState: { microphone: true, camera: false, screenShare: false }, error: null,
  setSession: (token) => { sessionStorage.setItem("accessToken", token); set({ token, error: null }); },
  setRoom: (roomId) => set({ roomId }), setCallContext: (callContext) => set({ callContext }), setSelf: (selfPeerId) => set({ selfPeerId }),
  setLocalMedia: (localPreviews, localState) => set({ localPreviews, localState: { ...localState } }),
  upsert: (participant) => set((state) => ({ participants: { ...state.participants, [participant.peerId]: { ...state.participants[participant.peerId], ...participant } } })),
  remove: (peerId) => set((state) => { const participants = { ...state.participants }; delete participants[peerId]; return { participants }; }),
  clearParticipants: () => set({ participants: {}, selfPeerId: null }),
  setError: (error) => set({ error }),
  reset: () => {
    sessionStorage.removeItem("accessToken");
    set({ token: null, roomId: null, callContext: null, selfPeerId: null, participants: {}, localPreviews: { camera: null, screen: null }, localState: { microphone: true, camera: false, screenShare: false }, error: null });
  },
}));
