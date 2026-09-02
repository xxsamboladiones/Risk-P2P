import { describe, expect, it, vi } from "vitest";
import {
  CALL_SOUND_SOURCES,
  CallPresenceSoundState,
  callSoundForRoomTransition,
  playCallSound,
  preloadCallSounds,
} from "./call-sounds";

describe("sons da chamada", () => {
  it("usa os arquivos OGG públicos empacotados pelo Vite", () => {
    expect(CALL_SOUND_SOURCES).toEqual({
      connect: "./audio/call/connect.ogg",
      disconnect: "./audio/call/disconnect.ogg",
    });
  });

  it("toca conexão somente ao entrar ou trocar de sala", () => {
    expect(callSoundForRoomTransition(null, "room-a")).toBe("connect");
    expect(callSoundForRoomTransition("room-a", "room-b")).toBe("connect");
    expect(callSoundForRoomTransition("room-a", "room-a")).toBeNull();
  });

  it("toca desconexão somente ao sair da sala", () => {
    expect(callSoundForRoomTransition("room-a", null)).toBe("disconnect");
    expect(callSoundForRoomTransition(null, null)).toBeNull();
  });

  it("não repete conexão para peers encontrados ao entrar em uma chamada existente", () => {
    const presence = new CallPresenceSoundState();
    presence.observe("peer-a");
    presence.enable();
    expect(presence.accept("peer-a")).toBeNull();
    expect(presence.accept("peer-a")).toBeNull();
    expect(presence.leave("peer-a")).toBe("disconnect");
  });

  it("toca conexão e desconexão para um peer que entra depois da sincronização inicial", () => {
    const presence = new CallPresenceSoundState();
    presence.enable();
    presence.observe("peer-b");
    expect(presence.accept("peer-b")).toBe("connect");
    expect(presence.leave("peer-b")).toBe("disconnect");
    expect(presence.leave("peer-b")).toBeNull();
  });

  it("aguarda a aceitação do peer antes de anunciar sua presença", () => {
    const presence = new CallPresenceSoundState();
    presence.enable();
    presence.observe("peer-auth");
    expect(presence.leave("peer-auth")).toBeNull();
  });

  it("carrega e reproduz o arquivo de conexão", () => {
    class FakeAudio {
      static readonly instances: FakeAudio[] = [];
      currentTime = 0;
      preload = "";
      volume = 1;
      readonly load = vi.fn();
      readonly pause = vi.fn();
      readonly play = vi.fn(async () => undefined);
      constructor(readonly src: string) { FakeAudio.instances.push(this); }
    }
    vi.stubGlobal("Audio", FakeAudio);
    try {
      preloadCallSounds();
      playCallSound("connect");
      expect(FakeAudio.instances.map((sound) => sound.src)).toEqual([
        "./audio/call/connect.ogg",
        "./audio/call/disconnect.ogg",
      ]);
      expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce();
      expect(FakeAudio.instances[0]?.volume).toBe(0.6);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
