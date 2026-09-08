import { WebScreenShareProvider, type CallTransport, type ScreenShareProvider } from "@risk/rtc";
import type { PeerState } from "@risk/protocol";
import { useCallStore } from "../store";
import { loadVoiceVideoSettings, type VoiceVideoSettings } from "../services/audio/settings";
import {
  applyScreenCaptureQuality,
  SCREEN_QUALITY_PROFILES,
  screenVideoPublication,
  type ScreenQualityProfile,
} from "../services/rtc/screen-quality";
import { openCamera } from "./media/camera";
import { createMicrophoneSession, stopMicrophoneSession, type MicrophoneSession } from "./media/microphone";
import {
  reportScreenAudioExclusion,
  startScreenCapture,
  stopDesktopScreenAudio,
  waitForPipeWireTrack,
  type DesktopScreenAudioPreparation,
} from "./media/screen-share";

export type MediaManagerDependencies = {
  getTransport(): CallTransport | undefined;
  currentLifecycle(): number;
  isActive(lifecycle: number): boolean;
  sendState(state: PeerState, failureMessage: string): void;
  reportError(error: unknown, fallback: string): void;
};

/**
 * Controla exclusivamente as capturas e publicações locais. O controller da
 * chamada não precisa conhecer tracks PipeWire, sessões RNNoise ou revisões de
 * qualidade da tela.
 */
export class MediaManager {
  private local = new MediaStream();
  private microphoneInputStream?: MediaStream;
  private microphone?: MediaStreamTrack;
  private rnnoiseMicrophone?: MicrophoneSession["rnnoise"];
  private microphoneSettings?: VoiceVideoSettings;
  private microphoneMonitorCleanup?: () => void;
  private microphoneMonitorRevision = 0;
  private microphoneRecovery?: { revision: number; promise: Promise<void> };
  private lastAutomaticMicrophoneRecoveryAt = Number.NEGATIVE_INFINITY;
  private camera?: MediaStreamTrack;
  private screenStream?: MediaStream;
  private screenQualityProfile: ScreenQualityProfile = SCREEN_QUALITY_PROFILES["1080p30"];
  private screenQualityRevision = 0;
  private peerState: PeerState = { microphone: true, camera: false, screenShare: false };

  constructor(
    private readonly dependencies: MediaManagerDependencies,
    private readonly screen: ScreenShareProvider = new WebScreenShareProvider(),
  ) {}

  get localStream(): MediaStream { return this.local; }
  get microphoneTrack(): MediaStreamTrack | undefined { return this.microphone; }
  get state(): PeerState { return this.peerState; }

  reset(): void {
    this.stopMicrophoneMonitor();
    this.lastAutomaticMicrophoneRecoveryAt = Number.NEGATIVE_INFINITY;
    this.local = new MediaStream();
    this.microphoneInputStream = undefined;
    this.microphone = undefined;
    this.rnnoiseMicrophone = undefined;
    this.microphoneSettings = undefined;
    this.camera = undefined;
    this.screenStream = undefined;
    this.peerState = { microphone: true, camera: false, screenShare: false };
  }

  async initializeMicrophone(
    settings: VoiceVideoSettings,
    transport: CallTransport,
    lifecycle: number,
  ): Promise<MediaStream> {
    const microphoneSession = await createMicrophoneSession(settings);
    if (!this.dependencies.isActive(lifecycle)) {
      await stopMicrophoneSession(microphoneSession);
      throw new DOMException("Entrada na chamada cancelada.", "AbortError");
    }

    this.microphoneInputStream = microphoneSession.inputStream;
    this.rnnoiseMicrophone = microphoneSession.rnnoise;
    this.microphone = microphoneSession.track;
    this.microphoneSettings = { ...settings };
    this.local.addTrack(microphoneSession.track);
    await transport.publishTrack(microphoneSession.track, this.local);
    if (!this.dependencies.isActive(lifecycle)) throw new DOMException("Entrada na chamada cancelada.", "AbortError");
    this.startMicrophoneMonitor(lifecycle);
    this.peerState.cameraStreamId = this.local.id;
    this.updateLocalPreview();
    return this.local;
  }

  async toggleMicrophone(): Promise<void> {
    try {
      const track = this.microphone ?? this.local.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      this.microphoneInputStream?.getAudioTracks().forEach((input) => { input.enabled = track.enabled; });
      this.peerState.microphone = track.enabled;
      this.notifyState("Não foi possível atualizar o microfone.");
      if (track.enabled) {
        const transport = this.dependencies.getTransport();
        if (transport) {
          await this.requestMicrophoneRecovery(transport, this.dependencies.currentLifecycle(), true, false);
        }
      }
    } catch (error) {
      this.dependencies.reportError(error, "Não foi possível alterar o microfone.");
    }
  }

  async updateVoiceInput(settings: VoiceVideoSettings): Promise<void> {
    const lifecycle = this.dependencies.currentLifecycle();
    const previousTrack = this.microphone;
    const previousInputStream = this.microphoneInputStream;
    const previousRnnoise = this.rnnoiseMicrophone;
    const transport = this.dependencies.getTransport();
    if (!previousTrack || !previousInputStream || !transport || !this.dependencies.isActive(lifecycle)) {
      throw new Error("A chamada não está pronta para trocar o dispositivo de áudio.");
    }

    const replacement = await createMicrophoneSession(settings);
    if (!this.dependencies.isActive(lifecycle) || this.microphone !== previousTrack) {
      await stopMicrophoneSession(replacement);
      throw new DOMException("Troca de microfone cancelada porque a chamada mudou.", "AbortError");
    }

    const syncEnabledState = () => {
      const enabled = this.peerState.microphone;
      replacement.track.enabled = enabled;
      replacement.inputStream.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    };
    syncEnabledState();

    try {
      await transport.replacePublishedTrack(previousTrack, replacement.track, this.local);
    } catch (error) {
      await stopMicrophoneSession(replacement);
      throw error;
    }
    if (!this.dependencies.isActive(lifecycle)) {
      await stopMicrophoneSession(replacement);
      return;
    }

    syncEnabledState();
    this.local.removeTrack(previousTrack);
    this.local.addTrack(replacement.track);
    this.microphoneInputStream = replacement.inputStream;
    this.microphone = replacement.track;
    this.rnnoiseMicrophone = replacement.rnnoise;
    this.microphoneSettings = { ...settings };
    this.startMicrophoneMonitor(lifecycle);
    this.updateLocalPreview();

    previousInputStream.getTracks().forEach((track) => track.stop());
    previousTrack.stop();
    await previousRnnoise?.stop().catch(() => undefined);
    console.info("Risk live microphone settings applied", {
      deviceId: replacement.inputStream.getAudioTracks()[0]?.getSettings().deviceId ?? "unknown",
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      muted: !this.peerState.microphone,
    });
  }

  async toggleCamera(): Promise<void> {
    const lifecycle = this.dependencies.currentLifecycle();
    try {
      if (this.camera) {
        const track = this.camera;
        this.camera = undefined;
        this.peerState.camera = false;
        this.notifyState("Não foi possível atualizar a câmera.");
        await this.dependencies.getTransport()?.unpublishTrack(track);
        if (!this.dependencies.isActive(lifecycle)) return;
        track.stop();
        this.local.removeTrack(track);
        return;
      }

      const { stream: cameraStream, track: cameraTrack } = await openCamera();
      if (!this.dependencies.isActive(lifecycle)) {
        cameraStream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.camera = cameraTrack;
      this.local.addTrack(cameraTrack);
      this.peerState.camera = true;
      this.notifyState("Não foi possível atualizar a câmera.");
      try {
        await this.dependencies.getTransport()?.publishTrack(cameraTrack, this.local, { source: "camera" });
      } catch (error) {
        if (this.camera === cameraTrack) this.camera = undefined;
        this.local.removeTrack(cameraTrack);
        cameraTrack.stop();
        this.peerState.camera = false;
        this.notifyState("Não foi possível atualizar a câmera.");
        throw error;
      }
      if (!this.dependencies.isActive(lifecycle)) cameraTrack.stop();
    } catch (error) {
      this.dependencies.reportError(error, "Não foi possível alterar a câmera.");
    }
  }

  async toggleScreen(
    sourceId: string | undefined,
    includeAudio: boolean,
    qualityProfile?: ScreenQualityProfile,
  ): Promise<void> {
    if (this.screenStream) {
      await this.stopScreen();
      return;
    }
    if (qualityProfile) this.setScreenQualityProfile(qualityProfile);
    const lifecycle = this.dependencies.currentLifecycle();
    let desktopAudio: DesktopScreenAudioPreparation | null = null;
    let linuxAudioPreparation: Promise<DesktopScreenAudioPreparation | null> | undefined;
    let stream: MediaStream | undefined;
    try {
      const settings = loadVoiceVideoSettings();
      const capture = await startScreenCapture(
        this.screen,
        sourceId,
        includeAudio,
        settings.excludeRiskAudioFromScreenShare,
      );
      stream = capture.stream;
      desktopAudio = capture.desktopAudio;
      linuxAudioPreparation = capture.linuxAudioPreparation;

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("A fonte selecionada não forneceu vídeo");
      }
      const publicationProfile = await this.applyLatestScreenCaptureQuality(videoTrack);

      if (desktopAudio?.mode === "unavailable") {
        const message = `PipeWire indisponível para áudio da tela: ${desktopAudio.reason ?? "ferramentas PipeWire não encontradas"}. A tela continuará sem áudio do sistema.`;
        console.warn(message);
        useCallStore.getState().setError(message);
      } else if (desktopAudio?.mode === "pipewire" && !stream.getAudioTracks().length) {
        const message = "A fonte virtual do PipeWire foi criada, mas o Chromium não a expôs como entrada de áudio. A tela continuará sem áudio do sistema.";
        console.warn(message);
        useCallStore.getState().setError(message);
      }

      const screenAudioTrack = stream.getAudioTracks()[0];
      if (screenAudioTrack && settings.excludeRiskAudioFromScreenShare) {
        reportScreenAudioExclusion(screenAudioTrack, desktopAudio, true);
      }
      if (!this.dependencies.isActive(lifecycle)) {
        stream.getTracks().forEach((track) => track.stop());
        await stopDesktopScreenAudio();
        return;
      }

      this.screenStream = stream;
      // Um evento tardio da captura anterior não pode encerrar uma nova
      // transmissão iniciada no mesmo MediaManager.
      videoTrack.addEventListener("ended", () => { void this.stopScreen(stream); }, { once: true });
      const transport = this.dependencies.getTransport();
      if (!transport) {
        stream.getTracks().forEach((track) => track.stop());
        await stopDesktopScreenAudio();
        this.screenStream = undefined;
        return;
      }

      this.peerState.screenShare = true;
      this.peerState.screenStreamId = stream.id;
      this.peerState.screenAudio = stream.getAudioTracks().length > 0;
      this.notifyState("Não foi possível atualizar o compartilhamento de tela.");
      await Promise.all(stream.getTracks().map((track) => transport.publishTrack(
        track,
        stream!,
        track.kind === "video" ? screenVideoPublication(publicationProfile) : undefined,
      )));
      if (!this.dependencies.isActive(lifecycle)) {
        stream.getTracks().forEach((track) => track.stop());
        await stopDesktopScreenAudio();
        return;
      }

      await this.requestMicrophoneRecovery(transport, lifecycle, true, false);
      if (linuxAudioPreparation) {
        void this.attachLinuxScreenAudio(stream, lifecycle, linuxAudioPreparation, settings.excludeRiskAudioFromScreenShare);
      }
    } catch (error) {
      if (linuxAudioPreparation) {
        void linuxAudioPreparation.then(() => stopDesktopScreenAudio()).catch(() => undefined);
      }
      if (stream && this.screenStream === stream) await this.stopScreen().catch(() => undefined);
      else await stopDesktopScreenAudio();
      if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
        this.dependencies.reportError(error, "Não foi possível compartilhar a tela.");
      }
    }
  }

  async updateScreenQuality(profile: ScreenQualityProfile): Promise<void> {
    this.setScreenQualityProfile(profile);
    const stream = this.screenStream;
    const track = stream?.getVideoTracks()[0];
    const transport = this.dependencies.getTransport();
    if (!stream || !track || !transport) return;

    const lifecycle = this.dependencies.currentLifecycle();
    const publicationProfile = await this.applyLatestScreenCaptureQuality(track);
    if (!this.dependencies.isActive(lifecycle) || this.screenStream !== stream || track.readyState !== "live") return;
    await transport.configurePublishedVideoTrack(track, screenVideoPublication(publicationProfile));
    this.updateLocalPreview();
  }

  async cleanup(): Promise<void> {
    const local = this.local;
    const inputStream = this.microphoneInputStream;
    const rnnoise = this.rnnoiseMicrophone;
    const screenStream = this.screenStream;
    this.reset();

    local.getTracks().forEach((track) => track.stop());
    inputStream?.getTracks().forEach((track) => track.stop());
    screenStream?.getTracks().forEach((track) => track.stop());
    useCallStore.getState().setLocalMedia({ microphone: null, camera: null, screen: null }, this.peerState);

    const screenCleanup = this.screen.stopScreenShare().catch(() => undefined);
    const desktopAudioCleanup = stopDesktopScreenAudio();
    await rnnoise?.stop().catch(() => undefined);
    await screenCleanup;
    await desktopAudioCleanup;
  }

  private async attachLinuxScreenAudio(
    stream: MediaStream,
    lifecycle: number,
    preparationPromise: Promise<DesktopScreenAudioPreparation | null>,
    excludeRisk: boolean,
  ): Promise<void> {
    try {
      const preparation = await preparationPromise;
      if (!this.dependencies.isActive(lifecycle) || this.screenStream !== stream) {
        if (preparation?.mode === "pipewire") await stopDesktopScreenAudio();
        return;
      }
      if (!preparation) return;
      if (preparation.mode === "unavailable") {
        const message = `PipeWire indisponível para áudio da tela: ${preparation.reason ?? "ferramentas PipeWire não encontradas"}. A tela continuará sem áudio do sistema.`;
        console.warn(message);
        useCallStore.getState().setError(message);
        return;
      }
      if (preparation.mode !== "pipewire") return;

      const audioTrack = await waitForPipeWireTrack(preparation);
      if (!this.dependencies.isActive(lifecycle) || this.screenStream !== stream) {
        audioTrack?.stop();
        await stopDesktopScreenAudio();
        return;
      }
      if (!audioTrack) {
        const message = "A fonte virtual do PipeWire foi criada, mas o Chromium não a expôs como entrada de áudio. A tela continuará sem áudio do sistema.";
        console.warn(message);
        useCallStore.getState().setError(message);
        return;
      }

      if (excludeRisk && preparation.excludedRisk) {
        console.info("Risk screen audio exclusion active", {
          mode: "pipewire-node-exclusion",
          source: preparation.sourceName ?? preparation.sourceLabel ?? "unknown",
        });
      }

      stream.addTrack(audioTrack);
      this.peerState.screenAudio = true;
      this.notifyState("Não foi possível atualizar o áudio da tela.");
      const transport = this.dependencies.getTransport();
      if (!transport) {
        stream.removeTrack(audioTrack);
        audioTrack.stop();
        this.peerState.screenAudio = false;
        this.updateLocalPreview();
        return;
      }

      try {
        await transport.publishTrack(audioTrack, stream);
        await this.requestMicrophoneRecovery(transport, lifecycle, true, false);
      } catch (error) {
        stream.removeTrack(audioTrack);
        audioTrack.stop();
        this.peerState.screenAudio = false;
        this.notifyState("Não foi possível atualizar o áudio da tela.");
        this.dependencies.reportError(error, "Não foi possível transmitir o áudio da tela.");
      }
    } catch (error) {
      console.warn("Falha ao anexar áudio PipeWire à transmissão.", error);
    }
  }

  private async stopScreen(expectedStream?: MediaStream): Promise<void> {
    const stream = this.screenStream;
    if (!stream || (expectedStream && stream !== expectedStream)) return;
    this.screenStream = undefined;
    this.peerState.screenShare = false;
    this.peerState.screenStreamId = undefined;
    this.peerState.screenAudio = false;
    this.notifyState("Não foi possível atualizar o compartilhamento de tela.");
    const transport = this.dependencies.getTransport();
    if (transport) {
      await Promise.all(stream.getTracks().map((track) => transport.unpublishTrack(track).catch(() => undefined)));
    }
    stream.getTracks().forEach((track) => track.stop());
    await this.screen.stopScreenShare().catch(() => undefined);
    await stopDesktopScreenAudio();
  }

  private startMicrophoneMonitor(lifecycle: number): void {
    this.stopMicrophoneMonitor();
    const revision = this.microphoneMonitorRevision;
    const inputTrack = this.microphoneInputStream?.getAudioTracks()[0];
    const publishedTrack = this.microphone;
    if (!inputTrack || !publishedTrack) return;

    const tracks = [...new Set([inputTrack, publishedTrack])];
    const recover = () => {
      if (!this.peerState.microphone || !this.dependencies.isActive(lifecycle)) return;
      const transport = this.dependencies.getTransport();
      if (!transport) return;
      void this.requestMicrophoneRecovery(transport, lifecycle, false, true).catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          this.dependencies.reportError(error, "O microfone parou de responder e não pôde ser recuperado.");
        }
      });
    };
    const recovered = () => {
      this.lastAutomaticMicrophoneRecoveryAt = Number.NEGATIVE_INFINITY;
    };
    tracks.forEach((track) => {
      track.addEventListener("mute", recover);
      track.addEventListener("ended", recover);
      track.addEventListener("unmute", recovered);
    });
    this.microphoneMonitorCleanup = () => {
      if (this.microphoneMonitorRevision !== revision) return;
      tracks.forEach((track) => {
        track.removeEventListener("mute", recover);
        track.removeEventListener("ended", recover);
        track.removeEventListener("unmute", recovered);
      });
      this.microphoneMonitorCleanup = undefined;
    };
  }

  private stopMicrophoneMonitor(): void {
    this.microphoneMonitorCleanup?.();
    this.microphoneMonitorCleanup = undefined;
    this.microphoneMonitorRevision += 1;
  }

  private async requestMicrophoneRecovery(
    transport: CallTransport,
    lifecycle: number,
    republishHealthyTrack: boolean,
    automatic: boolean,
  ): Promise<void> {
    const revision = this.microphoneMonitorRevision;
    const activeRecovery = this.microphoneRecovery;
    if (activeRecovery?.revision === revision) {
      await activeRecovery.promise;
      return;
    }
    if (automatic) {
      const now = Date.now();
      if (now - this.lastAutomaticMicrophoneRecoveryAt < 5_000) return;
      this.lastAutomaticMicrophoneRecoveryAt = now;
    }

    const promise = this.recoverMicrophone(transport, lifecycle, revision, republishHealthyTrack);
    const recovery = { revision, promise };
    this.microphoneRecovery = recovery;
    try {
      await promise;
    } finally {
      if (this.microphoneRecovery === recovery) this.microphoneRecovery = undefined;
    }
  }

  private async recoverMicrophone(
    transport: CallTransport,
    lifecycle: number,
    revision: number,
    republishHealthyTrack: boolean,
  ): Promise<void> {
    await this.rnnoiseMicrophone?.ensureRunning().catch((error) => {
      console.warn("Não foi possível reativar o RNNoise antes de verificar o microfone.", error);
    });
    const intendedEnabled = this.peerState.microphone;
    const currentMicrophone = this.microphone;
    const inputTrack = this.microphoneInputStream?.getAudioTracks()[0];
    if (!currentMicrophone || !inputTrack || !this.dependencies.isActive(lifecycle)) return;

    currentMicrophone.enabled = intendedEnabled;
    inputTrack.enabled = intendedEnabled;

    // Alguns capturadores suspendem brevemente a fonte de entrada enquanto o
    // portal de tela é aberto. Damos tempo para o unmute nativo antes de criar
    // outra captura e renegociar o sender.
    if (microphoneTrackUnavailable(currentMicrophone) || microphoneTrackUnavailable(inputTrack)) {
      await waitForMicrophoneRecovery(currentMicrophone, inputTrack);
    }
    if (
      !this.dependencies.isActive(lifecycle)
      || this.microphone !== currentMicrophone
      || this.microphoneMonitorRevision !== revision
    ) return;

    if (!microphoneTrackUnavailable(currentMicrophone) && !microphoneTrackUnavailable(inputTrack)) {
      if (republishHealthyTrack) await transport.publishTrack(currentMicrophone, this.local);
      return;
    }

    const settings = this.microphoneSettings ?? loadVoiceVideoSettings();
    const currentDeviceId = inputTrack.getSettings().deviceId?.trim();
    await this.updateVoiceInput(currentDeviceId
      ? { ...settings, microphoneDeviceId: currentDeviceId }
      : settings);
  }

  private setScreenQualityProfile(profile: ScreenQualityProfile): void {
    this.screenQualityProfile = profile;
    this.screenQualityRevision += 1;
  }

  private async applyLatestScreenCaptureQuality(track: MediaStreamTrack): Promise<ScreenQualityProfile> {
    for (;;) {
      const revision = this.screenQualityRevision;
      const profile = this.screenQualityProfile;
      await applyScreenCaptureQuality(track, profile);
      if (revision === this.screenQualityRevision) return profile;
    }
  }

  private notifyState(failureMessage: string): void {
    this.updateLocalPreview();
    this.dependencies.sendState(this.peerState, failureMessage);
  }

  private updateLocalPreview(): void {
    useCallStore.getState().setLocalMedia({
      microphone: this.microphone ? new MediaStream([this.microphone]) : null,
      camera: this.camera ? new MediaStream([this.camera]) : null,
      screen: this.screenStream ? new MediaStream(this.screenStream.getVideoTracks()) : null,
    }, this.peerState);
  }
}

function microphoneTrackUnavailable(track: MediaStreamTrack): boolean {
  return track.readyState !== "live" || track.muted;
}

async function waitForMicrophoneRecovery(...tracks: MediaStreamTrack[]): Promise<void> {
  if (tracks.every((track) => !microphoneTrackUnavailable(track))) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled || tracks.some((track) => microphoneTrackUnavailable(track))) return;
      settled = true;
      clearTimeout(timeout);
      tracks.forEach((track) => track.removeEventListener("unmute", finish));
      resolve();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      tracks.forEach((track) => track.removeEventListener("unmute", finish));
      resolve();
    }, 1_500);
    tracks.forEach((track) => track.addEventListener("unmute", finish));
    finish();
  });
}
