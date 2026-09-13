import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteAudioPlayback } from "./remote-playback";

class FakeAudio {
  static instances: FakeAudio[] = [];
  autoplay = false;
  muted = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  constructor() { FakeAudio.instances.push(this); }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "suspended";
  currentTime = 0;
  destination = {};
  gain = { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  source = { connect: vi.fn(() => this.gain), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  createGain = vi.fn(() => this.gain);
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { FakeAudioContext.instances.push(this); }
}

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudioContext.instances = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => vi.unstubAllGlobals());

describe("reprodução remota independente do vídeo", () => {
  it("mantém um elemento próprio reproduzindo a voz mesmo quando o vídeo troca de fonte", () => {
    const microphone = {} as MediaStream;
    const playback = createRemoteAudioPlayback(microphone, 100);
    const element = FakeAudio.instances[0]!;
    const context = FakeAudioContext.instances[0]!;
    expect(element.srcObject).toBe(microphone);
    expect(element.muted).toBe(true);
    expect(element.play).toHaveBeenCalledOnce();
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(microphone);
    expect(context.gain.gain.value).toBe(1);
    playback.setVolume(0);
    expect(context.gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.015);
    expect(element.pause).not.toHaveBeenCalled();
    playback.setVolume(200);
    expect(context.gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(2, 0, 0.015);
    expect(element.muted).toBe(true);
    playback.stop();
  });

  it("encerra o áudio da tela sem interromper a voz nem parar tracks recebidas", () => {
    const stopTrack = vi.fn();
    const microphone = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const voice = createRemoteAudioPlayback(microphone, 100);
    const screen = createRemoteAudioPlayback({} as MediaStream, 50);
    screen.stop();
    expect(FakeAudio.instances[0]!.srcObject).toBe(microphone);
    expect(FakeAudio.instances[0]!.pause).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances[0]!.close).not.toHaveBeenCalled();
    expect(FakeAudio.instances[1]!.srcObject).toBeNull();
    expect(stopTrack).not.toHaveBeenCalled();
    voice.stop();
    voice.stop();
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it("retoma a reprodução ao voltar à chamada e remove os listeners ao encerrar", () => {
    const playback = createRemoteAudioPlayback({} as MediaStream, 100);
    const element = FakeAudio.instances[0]!;
    const context = FakeAudioContext.instances[0]!;
    context.state = "suspended";
    window.dispatchEvent(new Event("focus"));
    expect(context.state).toBe("running");
    expect(element.play).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(element.play).toHaveBeenCalledTimes(3);
    playback.stop();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    playback.setVolume(200);
    expect(element.play).toHaveBeenCalledTimes(3);
    expect(element.srcObject).toBeNull();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.gain.disconnect).toHaveBeenCalledOnce();
  });
});
