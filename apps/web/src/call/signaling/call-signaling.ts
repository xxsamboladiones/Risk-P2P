import type {
  AnswerMessage,
  IceCandidateMessage,
  OfferMessage,
  PeerStateMessage,
  SignalingPeer,
  SignalingProvider,
  SignalingStatus,
} from "../../services/signaling/types";

export type CallSignalingHandlers = {
  peerJoined(peer: SignalingPeer): void;
  peerLeft(peerId: string): void;
  offer(message: OfferMessage): void;
  answer(message: AnswerMessage): void;
  iceCandidate(message: IceCandidateMessage): void;
  peerState(message: PeerStateMessage): void;
  statusChange(status: SignalingStatus): void;
};

/** Liga o provider ao domínio de chamada e devolve um único cleanup idempotente. */
export function bindCallSignaling(
  signaling: SignalingProvider,
  handlers: CallSignalingHandlers,
): () => void {
  const unsubscribers = [
    signaling.onPeerJoined(handlers.peerJoined),
    signaling.onPeerLeft(handlers.peerLeft),
    signaling.onOffer(handlers.offer),
    signaling.onAnswer(handlers.answer),
    signaling.onIceCandidate(handlers.iceCandidate),
    signaling.onPeerState(handlers.peerState),
    signaling.onStatusChange(handlers.statusChange),
  ];
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribers.reverse().forEach((unsubscribe) => unsubscribe());
  };
}
