import { describe, expect, it, vi } from "vitest";
import {
  CALL_SOUND_SOURCES,
  CallPresenceSoundState,
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

  it("ativa os sons de presença e toca uma desconexão ao sair", () => {
    const presence = new CallPresenceSoundState();
    presence.enable();
    expect(presence.disable()).toBe("disconnect");
    expect(presence.disable()).toBeNull();
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

  it("silencia peers iniciais mesmo quando autenticam depois da entrada local", () => {
    const presence = new CallPresenceSoundState();
    presence.observe("peer-inicial-a");
    presence.observe("peer-inicial-b");
    presence.enable();
    expect(presence.accept("peer-inicial-a")).toBeNull();
    expect(presence.accept("peer-inicial-b")).toBeNull();
    presence.observe("peer-novo");
    expect(presence.accept("peer-novo")).toBe("connect");
  });

  it("toca para quem entra e para cada membro que já estava na chamada", () => {
    const membroA = new CallPresenceSoundState();
    const membroB = new CallPresenceSoundState();
    membroA.enable();
    membroB.enable();

    const novoMembro = new CallPresenceSoundState();
    novoMembro.observe("peer-a");
    novoMembro.observe("peer-b");
    novoMembro.enable();
    expect(novoMembro.accept("peer-a")).toBeNull();
    expect(novoMembro.accept("peer-b")).toBeNull();

    membroA.observe("peer-novo");
    membroB.observe("peer-novo");
    expect(membroA.accept("peer-novo")).toBe("connect");
    expect(membroB.accept("peer-novo")).toBe("connect");
  });

  it("carrega e inicia o arquivo de conexão sem adiar o play", () => {
    class FakeAudio {
      static readonly instances: FakeAudio[] = [];
      currentTime = 0;
      muted = false;
      preload = "";
      volume = 1;
      readonly addEventListener = vi.fn();
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
      expect(FakeAudio.instances[0]?.muted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gera o som de conexão pelo Web Audio quando disponível", () => {
    const starts: number[] = [];
    const frequencies: number[] = [];
    const createOscillator = vi.fn(() => ({
      type: "sine",
      frequency: { setValueAtTime: (value: number) => frequencies.push(value) },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: (at: number) => starts.push(at),
      stop: vi.fn(),
    }));
    const createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }));
    class FakeAudioContext {
      readonly state = "running";
      readonly currentTime = 1;
      readonly destination = {};
      readonly createOscillator = createOscillator;
      readonly createGain = createGain;
      readonly resume = vi.fn(async () => undefined);
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    try {
      playCallSound("connect");
      expect(frequencies).toEqual([523.25, 783.99]);
      expect(starts).toEqual([1.01, 1.15]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
