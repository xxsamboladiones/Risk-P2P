import { describe, expect, it, vi } from "vitest";
import type { SignalingProvider } from "../../services/signaling/types";
import { bindCallSignaling, type CallSignalingHandlers } from "./call-signaling";

describe("bindCallSignaling", () => {
  it("registra todos os eventos e limpa cada inscrição uma única vez", () => {
    const cleanups = Array.from({ length: 7 }, () => vi.fn());
    const registrations = Array.from({ length: 7 }, (_, index) => vi.fn(() => cleanups[index]!));
    const signaling = {
      onPeerJoined: registrations[0],
      onPeerLeft: registrations[1],
      onOffer: registrations[2],
      onAnswer: registrations[3],
      onIceCandidate: registrations[4],
      onPeerState: registrations[5],
      onStatusChange: registrations[6],
    } as unknown as SignalingProvider;
    const handlers = {
      peerJoined: vi.fn(), peerLeft: vi.fn(), offer: vi.fn(), answer: vi.fn(),
      iceCandidate: vi.fn(), peerState: vi.fn(), statusChange: vi.fn(),
    } satisfies CallSignalingHandlers;

    const cleanup = bindCallSignaling(signaling, handlers);
    registrations.forEach((registration) => expect(registration).toHaveBeenCalledOnce());
    cleanup();
    cleanup();
    cleanups.forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalledOnce());
  });
});
