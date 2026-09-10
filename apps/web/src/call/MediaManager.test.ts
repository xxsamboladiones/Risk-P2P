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
      muted: false,
      readyState: "live",
      contentHint: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
      automaticGainControl: false,
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
      muted: false,
      readyState: "live",
      contentHint: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
      automaticGainControl: false,
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

  it("reabre o microfone no Linux ao encerrar uma transmissão sem áudio mesmo se a track parecer saudável", async () => {
    const oldMicrophone = {
      id: "mic-old",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic antigo",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({ deviceId: "mic-linux" }),
    } as unknown as MediaStreamTrack;
    const newMicrophone = {
      id: "mic-new",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic recuperado",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({ deviceId: "mic-linux" }),
    } as unknown as MediaStreamTrack;
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(new FakeMediaStream([oldMicrophone]))
      .mockResolvedValueOnce(new FakeMediaStream([newMicrophone]));
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux", mediaDevices: { getUserMedia } });

    const screenTrack = {
      kind: "video",
      muted: false,
      readyState: "live",
      contentHint: "",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      applyConstraints: vi.fn(async () => undefined),
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
      automaticGainControl: false,
      excludeRiskAudioFromScreenShare: true,
    };

    await manager.initializeMicrophone(settings, transport, 1);
    await manager.toggleScreen(undefined, false);
    const getBackendConfig = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:3030", token: "token" }));
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("window", { desktop: { getBackendConfig } });
    vi.stubGlobal("fetch", fetchMock);
    await manager.toggleScreen(undefined, false);

    expect(replacePublishedTrack).toHaveBeenCalledWith(oldMicrophone, newMicrophone, manager.localStream);
    expect(manager.microphoneTrack).toBe(newMicrophone);
    expect(manager.state.microphone).toBe(true);
    expect(newMicrophone.enabled).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3030/screen-audio/stop-capture",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3030/screen-audio/microphone-guard/stop",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock.mock.invocationCallOrder[0]!).toBeLessThan(getUserMedia.mock.invocationCallOrder[1]!);
    expect(getUserMedia.mock.invocationCallOrder[1]!).toBeLessThan(fetchMock.mock.invocationCallOrder[1]!);
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
      automaticGainControl: false,
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

  it("detecta no Linux uma captura live que parou de produzir amostras após inatividade", async () => {
    vi.useFakeTimers();
    const oldMicrophone = {
      id: "mic-idle",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic suspenso",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({ deviceId: "mic-linux" }),
    } as unknown as MediaStreamTrack;
    const newMicrophone = {
      id: "mic-awake",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic retomado",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({ deviceId: "mic-linux" }),
    } as unknown as MediaStreamTrack;
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(new FakeMediaStream([oldMicrophone]))
      .mockResolvedValueOnce(new FakeMediaStream([newMicrophone]));
    const windowListeners = new EventTarget();
    vi.stubGlobal("window", {
      desktop: {},
      addEventListener: windowListeners.addEventListener.bind(windowListeners),
      removeEventListener: windowListeners.removeEventListener.bind(windowListeners),
    });
    const documentListeners = new EventTarget();
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: documentListeners.addEventListener.bind(documentListeners),
      removeEventListener: documentListeners.removeEventListener.bind(documentListeners),
    });
    vi.stubGlobal("navigator", { userAgent: "Linux", mediaDevices: { getUserMedia } });

    const sampleLocalAudio = vi.fn(async () => ({ totalSamplesDuration: 10, sampledAt: Date.now() }));
    const replacePublishedTrack = vi.fn(async () => undefined);
    const transport = {
      publishTrack: vi.fn(async () => undefined),
      replacePublishedTrack,
      sampleLocalAudio,
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
      automaticGainControl: false,
      excludeRiskAudioFromScreenShare: true,
    };

    await manager.initializeMicrophone(settings, transport, 1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sampleLocalAudio).toHaveBeenCalledTimes(3);
    expect(replacePublishedTrack).toHaveBeenCalledWith(oldMicrophone, newMicrophone, manager.localStream);
    expect(manager.microphoneTrack).toBe(newMicrophone);
    expect(manager.state.microphone).toBe(true);

    await manager.cleanup();
    vi.useRealTimers();
  });

  it("reinicia uma captura do Windows que permanece muda sem recriar a chamada", async () => {
    vi.useFakeTimers();
    const screenListeners = new Map<string, Set<EventListener>>();
    const microphone = {
      id: "mic",
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
      label: "Mic",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({ deviceId: "mic" }),
    } as unknown as MediaStreamTrack;
    const oldScreenTrack = {
      id: "screen-old",
      kind: "video",
      enabled: true,
      muted: false,
      readyState: "live",
      contentHint: "",
      stop: vi.fn(),
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const handlers = screenListeners.get(type) ?? new Set<EventListener>();
        handlers.add(listener);
        screenListeners.set(type, handlers);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        screenListeners.get(type)?.delete(listener);
      }),
      applyConstraints: vi.fn(async () => undefined),
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as unknown as MediaStreamTrack & { muted: boolean };
    const newScreenTrack = {
      id: "screen-new",
      kind: "video",
      enabled: true,
      muted: false,
      readyState: "live",
      contentHint: "",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      applyConstraints: vi.fn(async () => undefined),
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as unknown as MediaStreamTrack;
    const microphoneStream = new FakeMediaStream([microphone]) as unknown as MediaStream;
    const oldScreenStream = new FakeMediaStream([oldScreenTrack]) as unknown as MediaStream;
    const newScreenStream = new FakeMediaStream([newScreenTrack]) as unknown as MediaStream;
    vi.stubGlobal("window", { desktop: {} });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      mediaDevices: { getUserMedia: vi.fn(async () => microphoneStream) },
    });

    const screen = {
      startScreenShare: vi.fn()
        .mockResolvedValueOnce(oldScreenStream)
        .mockResolvedValueOnce(newScreenStream),
      stopScreenShare: vi.fn(async () => undefined),
    } as unknown as ScreenShareProvider;
    const publishTrack = vi.fn(async () => undefined);
    const unpublishTrack = vi.fn(async () => undefined);
    const transport = { publishTrack, unpublishTrack } as unknown as CallTransport;
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
      automaticGainControl: false,
      excludeRiskAudioFromScreenShare: true,
    };

    await manager.initializeMicrophone(settings, transport, 1);
    await manager.toggleScreen("screen:1", false);
    oldScreenTrack.muted = true;
    screenListeners.get("mute")?.forEach((listener) => listener(new Event("mute")));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(screen.startScreenShare).toHaveBeenNthCalledWith(1, "screen:1", false);
    expect(screen.startScreenShare).toHaveBeenNthCalledWith(2, "screen:1", false);
    expect(unpublishTrack).toHaveBeenCalledWith(oldScreenTrack);
    expect(publishTrack).toHaveBeenCalledWith(newScreenTrack, newScreenStream, expect.objectContaining({ source: "screen" }));
    expect(manager.state.screenShare).toBe(true);

    await manager.cleanup();
    vi.useRealTimers();
  });
});
