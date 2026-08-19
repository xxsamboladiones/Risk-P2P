export type PeerState = {
  microphone: boolean;
  camera: boolean;
  screenShare: boolean;
  cameraStreamId?: string;
  screenStreamId?: string;
  screenAudio?: boolean;
};

export type IceCandidatePayload = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
};
