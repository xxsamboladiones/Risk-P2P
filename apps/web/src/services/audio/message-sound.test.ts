import { expect, it, vi } from "vitest";
import { playMessageSound, prepareMessageSound, MESSAGE_SOUND_SOURCE } from "./message-sound";

it("reproduz o OGG fornecido e não interrompe mensagem recebida durante o desbloqueio", async () => {
  const doc = new EventTarget();
  let resolveUnlock!: () => void;
  const audio = {
    load: vi.fn(), pause: vi.fn(), muted: false, currentTime: 0, preload: "",
    play: vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { resolveUnlock = resolve; }))
      .mockResolvedValue(undefined),
  };
  const AudioMock = vi.fn(function () { return audio; });
  vi.stubGlobal("Audio", AudioMock); vi.stubGlobal("document", doc);
  const cleanup = prepareMessageSound();
  try {
    expect(AudioMock).toHaveBeenCalledWith(MESSAGE_SOUND_SOURCE);
    doc.dispatchEvent(new Event("pointerdown"));
    playMessageSound();
    expect(audio.muted).toBe(false);
    resolveUnlock();
    await Promise.resolve(); await Promise.resolve();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(2);
  } finally { cleanup(); vi.unstubAllGlobals(); }
});
