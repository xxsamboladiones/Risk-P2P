import { describe, expect, it } from "vitest";
import { GamePlayout } from "./game-playout";

describe("reprodução interativa", () => {
  it("reduz a espera de áudio e vídeo juntos e restaura os valores anteriores ao sair", () => {
    const audio = { jitterBufferTarget: 120 }, video = { jitterBufferTarget: null };
    const receivers = [audio, video] as unknown as RTCRtpReceiver[];
    const policy = new GamePlayout();
    policy.apply(receivers);
    expect([audio.jitterBufferTarget, video.jitterBufferTarget]).toEqual([0, 0]);
    policy.apply(receivers);
    policy.apply(receivers, 30);
    expect([audio.jitterBufferTarget, video.jitterBufferTarget]).toEqual([30, 30]);
    policy.restore();
    expect([audio.jitterBufferTarget, video.jitterBufferTarget]).toEqual([120, null]);
  });
  it("não interrompe o jogo em navegadores sem suporte ou que rejeitam a opção", () => {
    const unsupported = {};
    const rejects = { get jitterBufferTarget() { return null; }, set jitterBufferTarget(_: number | null) { throw new Error("unsupported"); } };
    const policy = new GamePlayout();
    expect(() => policy.apply([unsupported, rejects] as unknown as RTCRtpReceiver[])).not.toThrow();
    expect(unsupported).not.toHaveProperty("jitterBufferTarget");
    expect(() => policy.restore()).not.toThrow();
  });
});
