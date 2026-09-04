export type MeshPeerEntry = {
  pc: RTCPeerConnection;
  canNegotiate: boolean;
  makingOffer: boolean;
  needsNegotiation: boolean;
  needsIceRestart: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  pendingIceCandidates: RTCIceCandidateInit[];
  dataChannel?: RTCDataChannel;
  transferDataChannel?: RTCDataChannel;
  initiator: boolean;
  descriptionChain: Promise<void>;
};

export function createMeshPeerEntry(pc: RTCPeerConnection): MeshPeerEntry {
  return {
    pc,
    canNegotiate: false,
    makingOffer: false,
    needsNegotiation: false,
    needsIceRestart: false,
    ignoreOffer: false,
    settingRemoteAnswer: false,
    pendingIceCandidates: [],
    initiator: false,
    descriptionChain: Promise.resolve(),
  };
}
