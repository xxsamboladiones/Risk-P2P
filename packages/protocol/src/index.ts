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

type Directed<T extends string, P> = { type: T; roomId: string; targetPeerId: string; payload: P };

export type ClientMessage =
  | { type: "authenticate"; token: string }
  | { type: "join-room"; roomId: string }
  | { type: "leave-room"; roomId: string }
  | Directed<"offer", { sdp: string }>
  | Directed<"answer", { sdp: string }>
  | Directed<"ice-candidate", IceCandidatePayload>
  | { type: "peer-state"; roomId: string; state: PeerState }
  | { type: "heartbeat" };

export type ServerMessage =
  | { type: "authenticated"; peerId: string; userId: string }
  | { type: "room-joined"; roomId: string; peers: Array<{ peerId: string; displayName: string; state: PeerState }> }
  | { type: "peer-joined"; roomId: string; peerId: string; displayName: string; state: PeerState }
  | { type: "peer-left"; roomId: string; peerId: string }
  | (Directed<"offer", { sdp: string }> & { fromPeerId: string })
  | (Directed<"answer", { sdp: string }> & { fromPeerId: string })
  | (Directed<"ice-candidate", IceCandidatePayload> & { fromPeerId: string })
  | { type: "peer-state"; roomId: string; peerId: string; state: PeerState }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

export function parseServerMessage(value: string): ServerMessage {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
    throw new Error("Mensagem inválida recebida do servidor");
  }
  return parsed as ServerMessage;
}
