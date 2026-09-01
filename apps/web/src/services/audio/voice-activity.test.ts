import { describe, expect, it } from "vitest";
import { nextVoiceActivityState, rootMeanSquare } from "./voice-activity";

const OPTIONS = { startThreshold: 0.018, continueThreshold: 0.009, releaseMs: 240 };

describe("detecção de atividade de voz", () => {
  it("calcula o nível RMS das amostras", () => {
    expect(rootMeanSquare(new Float32Array([0, 0, 0]))).toBe(0);
    expect(rootMeanSquare(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });

  it("acende somente quando a voz ultrapassa o limiar inicial", () => {
    const silent = { speaking: false, lastVoiceAt: 0 };
    expect(nextVoiceActivityState(silent, 0.01, 100, OPTIONS)).toEqual(silent);
    expect(nextVoiceActivityState(silent, 0.02, 100, OPTIONS)).toEqual({ speaking: true, lastVoiceAt: 100 });
  });

  it("mantém a borda entre sílabas e apaga após a retenção", () => {
    const speaking = { speaking: true, lastVoiceAt: 100 };
    expect(nextVoiceActivityState(speaking, 0, 300, OPTIONS).speaking).toBe(true);
    expect(nextVoiceActivityState(speaking, 0, 340, OPTIONS).speaking).toBe(false);
    expect(nextVoiceActivityState(speaking, 0.01, 500, OPTIONS)).toEqual({ speaking: true, lastVoiceAt: 500 });
  });
});
