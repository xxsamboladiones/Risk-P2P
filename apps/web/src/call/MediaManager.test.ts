import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CallTransport, ScreenShareProvider } from "@risk/rtc";
import type { VoiceVideoSettings } from "../services/audio/settings";

type MediaManagerConstructor = typeof import("./MediaManager")["MediaManager"];
let MediaManager: MediaManagerConstructor;

class FakeMediaStream {
  readonly id = "local-media";
  constructor(private readonly tracks: MediaStreamTrack[] = []) {}
  addTrack(track: MediaStreamTrack): void { this.tracks.push(track); }
  removeTrack(track: MediaStreamTrack): void {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
  }
  getTracks(): MediaStreamTrack[] { return [...this.tracks]; }
  getAudioTracks(): MediaStreamTrack[] { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks(): MediaStreamTrack[] { return this.tracks.filter((track) => track.kind === "video"); }
}

beforeAll(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("window", {});
  ({ MediaManager } = await import("./MediaManager"));
});

afterAll(() => vi.unstubAllGlobals());

describe("MediaManager", () => {
  it("publica o microfone e mantém mute e estado local sincronizados", async () => {
    const stop = vi.fn();
    const microphone = {
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic de teste",
      stop,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      applyConstraints: vi.fn(async () => undefined),
      getConstraints: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: false }),
      getSettings: () => ({ deviceId: "mic-test" }),
    } as unknown as MediaStreamTrack;
    const inputStream = new FakeMediaStream([microphone]) as unknown as MediaStream;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => inputStream) } });

    const publishTrack = vi.fn(async () => undefined);
    const unpublishTrack = vi.fn(async () => undefined);
    const transport = { publishTrack, unpublishTrack } as unknown as CallTransport;
    const sendState = vi.fn();
    const screenTrack = {
      kind: "video",
      readyState: "live",
      contentHint: "",
      addEventListener: vi.fn(),
      applyConstraints: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const screenStream = new FakeMediaStream([screenTrack]) as unknown as MediaStream;
    const screen = {
      getSources: vi.fn(async () => []),
      startScreenShare: vi.fn(async () => screenStream),
      stopScreenShare: vi.fn(async () => undefined),
    } as unknown as ScreenShareProvider;
    const manager = new MediaManager({
      getTransport: () => transport,
      currentLifecycle: () => 1,
      isActive: () => true,
      sendState,
      reportError: vi.fn(),
    }, screen);
    const settings: VoiceVideoSettings = {
      microphoneDeviceId: "",
      noiseSuppression: "standard",
      echoCancellation: true,
      excludeRiskAudioFromScreenShare: true,
    };

    await expect(manager.initializeMicrophone(settings, transport, 1)).resolves.toBe(manager.localStream);
    expect(publishTrack).toHaveBeenCalledWith(microphone, manager.localStream);
    expect(manager.state.cameraStreamId).toBe("local-media");

    await manager.toggleScreen(undefined, false);
    expect(microphone.enabled).toBe(true);
    expect(microphone.applyConstraints).not.toHaveBeenCalled();
    expect(publishTrack).toHaveBeenLastCalledWith(microphone, manager.localStream);
    await manager.toggleScreen(undefined, false);
    expect(unpublishTrack).toHaveBeenCalledWith(screenTrack);

    await manager.toggleScreen(undefined, true);
    expect(microphone.applyConstraints).not.toHaveBeenCalled();
    await manager.toggleScreen(undefined, true);

    await manager.toggleMicrophone();
    expect(microphone.enabled).toBe(false);
    expect(sendState).toHaveBeenCalledWith(expect.objectContaining({ microphone: false }), expect.any(String));

    await manager.cleanup();
    expect(stop).toHaveBeenCalled();
    expect(manager.state).toEqual({ microphone: true, camera: false, screenShare: false });
  });

  it("substitui o microfone que permanece mudo após compartilhar sem áudio", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<EventListener>>();
    const oldStop = vi.fn();
    const oldMicrophone = {
      id: "mic-old",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic antigo",
      stop: oldStop,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const handlers = listeners.get(type) ?? new Set<EventListener>();
        handlers.add(listener);
        listeners.set(type, handlers);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      }),
      applyConstraints: vi.fn(async () => undefined),
      getConstraints: () => ({ echoCancellation: true, autoGainControl: false }),
      getSettings: () => ({ deviceId: "mic-old" }),
    } as unknown as MediaStreamTrack & { muted: boolean };
    const newMicrophone = {
      id: "mic-new",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic novo",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      applyConstraints: vi.fn(async () => undefined),
      getConstraints: () => ({ echoCancellation: true, autoGainControl: false }),
      getSettings: () => ({ deviceId: "mic-new" }),
    } as unknown as MediaStreamTrack;
    const oldInput = new FakeMediaStream([oldMicrophone]) as unknown as MediaStream;
    const newInput = new FakeMediaStream([newMicrophone]) as unknown as MediaStream;
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(oldInput)
      .mockResolvedValueOnce(newInput);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const screenTrack = {
      id: "screen-video",
      kind: "video",
      readyState: "live",
      contentHint: "",
      addEventListener: vi.fn(),
      applyConstraints: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const screenStream = new FakeMediaStream([screenTrack]) as unknown as MediaStream;
    const screen = {
      startScreenShare: vi.fn(async () => screenStream),
      stopScreenShare: vi.fn(async () => undefined),
    } as unknown as ScreenShareProvider;
    const replacePublishedTrack = vi.fn(async () => undefined);
    const transport = {
      publishTrack: vi.fn(async () => undefined),
      unpublishTrack: vi.fn(async () => undefined),
      replacePublishedTrack,
    } as unknown as CallTransport;
    const manager = new MediaManager({
      getTransport: () => transport,
      currentLifecycle: () => 1,
      isActive: () => true,
      sendState: vi.fn(),
      reportError: vi.fn(),
    }, screen);
    const settings: VoiceVideoSettings = {
      microphoneDeviceId: "",
      noiseSuppression: "standard",
      echoCancellation: true,
      excludeRiskAudioFromScreenShare: true,
    };

    await manager.initializeMicrophone(settings, transport, 1);
    await manager.toggleScreen(undefined, false);
    oldMicrophone.muted = true;
    listeners.get("mute")?.forEach((listener) => listener(new Event("mute")));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(replacePublishedTrack).toHaveBeenCalledWith(oldMicrophone, newMicrophone, manager.localStream);
    expect(manager.microphoneTrack).toBe(newMicrophone);
    expect(manager.state.microphone).toBe(true);
    expect(newMicrophone.enabled).toBe(true);
    expect(oldMicrophone.applyConstraints).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: "mic-old" } }),
      video: false,
    });
    expect(oldStop).toHaveBeenCalled();

    await manager.cleanup();
    vi.useRealTimers();
  });

  it("recupera um microfone que fica mudo durante a chamada normal", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<EventListener>>();
    const oldStop = vi.fn();
    const oldMicrophone = {
      id: "mic-old",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic antigo",
      stop: oldStop,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const handlers = listeners.get(type) ?? new Set<EventListener>();
        handlers.add(listener);
        listeners.set(type, handlers);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      }),
      getSettings: () => ({ deviceId: "mic-old" }),
    } as unknown as MediaStreamTrack & { muted: boolean };
    const emit = (type: string) => listeners.get(type)?.forEach((listener) => listener(new Event(type)));
    const newMicrophone = {
      id: "mic-new",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic novo",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({ deviceId: "mic-new" }),
    } as unknown as MediaStreamTrack;
    const oldInput = new FakeMediaStream([oldMicrophone]) as unknown as MediaStream;
    const newInput = new FakeMediaStream([newMicrophone]) as unknown as MediaStream;
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(oldInput)
      .mockResolvedValueOnce(newInput);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const replacePublishedTrack = vi.fn(async () => undefined);
    const transport = {
      publishTrack: vi.fn(async () => undefined),
      replacePublishedTrack,
    } as unknown as CallTransport;
    const manager = new MediaManager({
      getTransport: () => transport,
      currentLifecycle: () => 1,
      isActive: () => true,
      sendState: vi.fn(),
      reportError: vi.fn(),
    });
    const settings: VoiceVideoSettings = {
      microphoneDeviceId: "",
      noiseSuppression: "standard",
      echoCancellation: true,
      excludeRiskAudioFromScreenShare: true,
    };

    await manager.initializeMicrophone(settings, transport, 1);
    oldMicrophone.muted = true;
    emit("mute");
    await vi.advanceTimersByTimeAsync(1_500);

    expect(replacePublishedTrack).toHaveBeenCalledWith(oldMicrophone, newMicrophone, manager.localStream);
    expect(manager.microphoneTrack).toBe(newMicrophone);
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: "mic-old" } }),
      video: false,
    });
    expect(oldStop).toHaveBeenCalled();

    await manager.cleanup();
    vi.useRealTimers();
  });
});
