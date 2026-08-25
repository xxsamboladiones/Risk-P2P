import { describe, expect, it, vi } from "vitest";
import { SupabaseSignalingProvider } from "./signaling";

function internals(provider: SupabaseSignalingProvider): Record<string, any> {
  return provider as unknown as Record<string, any>;
}

describe("SupabaseSignalingProvider reconnect sends", () => {
  it("aguarda reconnect antes de enviar peer.state", async () => {
    const provider = new SupabaseSignalingProvider();
    const state = internals(provider);
    const send = vi.fn(async () => "ok");

    state.roomId = "room-test";
    state.peerId = "peer-test";
    state.channelName = "risk:room:test";
    state.client = { channel: vi.fn(), removeChannel: vi.fn(async () => undefined) };
    state.status = "reconnecting";

    const pending = provider.sendPeerState({ microphone: true, camera: false, screenShare: false });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = undefined;
    state.channel = { send };
    state.setStatus("connected");

    await expect(pending).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });
});
