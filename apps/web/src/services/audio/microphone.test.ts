import { afterEach, describe, expect, it, vi } from "vitest";
import { openConfiguredMicrophone } from "./microphone";
import type { VoiceVideoSettings } from "./settings";

const settings: VoiceVideoSettings = {
  microphoneDeviceId: "usb-mic-123",
  noiseSuppression: "standard",
  echoCancellation: true,
  excludeRiskAudioFromScreenShare: true,
};

const fakeStream = {} as MediaStream;

afterEach(() => vi.unstubAllGlobals());

describe("openConfiguredMicrophone", () => {
  it("solicita exatamente o microfone salvo", async () => {
    const getUserMedia = vi.fn(async () => fakeStream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openConfiguredMicrophone(settings)).resolves.toBe(fakeStream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: "usb-mic-123" },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  });

  it("usa o microfone padrão se o dispositivo salvo não existir mais", async () => {
    const unavailable = Object.assign(new Error("device missing"), { name: "NotFoundError" });
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(fakeStream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openConfiguredMicrophone(settings)).resolves.toBe(fakeStream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  });
});
