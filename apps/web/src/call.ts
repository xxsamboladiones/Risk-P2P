import { MeshWebRTCTransport, WebScreenShareProvider, type PeerConnectionDiagnostics } from "@risk/rtc";
import type { PeerState } from "@risk/protocol";
import { useCallStore, type Participant } from "./store";
import { api } from "./api";
import { openConfiguredMicrophone } from "./services/audio/microphone";
import { createRnnoiseMicrophone, type RnnoiseMicrophone } from "./services/audio/rnnoise";
import { loadVoiceVideoSettings, type VoiceVideoSettings } from "./services/audio/settings";
import { SupabaseSignalingProvider } from "./services/supabase/signaling";
import type { SignalingDiagnostics, SignalingProvider } from "./services/signaling/types";

export type CallDiagnostics = {
  signaling: SignalingDiagnostics | null;
  peerConnections: PeerConnectionDiagnostics[];
};

type DisplayAudioSettings = MediaTrackSettings & { restrictOwnAudio?: boolean };
type DesktopScreenAudioPreparation = {
  mode: "display" | "pipewire" | "unavailable";
  sourceName?: string;
  sourceLabel?: string;
  excludedRisk: boolean;
  reason?: string;
};

type MicrophoneSession = {
  inputStream: MediaStream;
  track: MediaStreamTrack;
  rnnoise?: RnnoiseMicrophone;
};

function placeholderParticipant(peerId: string): Participant {
  return {
    peerId,
    displayName: `Peer ${peerId.slice(0, 6)}`,
    state: { microphone: true, camera: false, screenShare: false },
    streams: {},
    connection: "new",
  };
}

async function createMicrophoneSession(settings: VoiceVideoSettings): Promise<MicrophoneSession> {
  const inputStream = await openConfiguredMicrophone(settings);
  const inputTrack = inputStream.getAudioTracks()[0];
  if (!inputTrack) {
    inputStream.getTracks().forEach((track) => track.stop());
    throw new Error("Nenhum microfone foi disponibilizado pelo navegador.");
  }

  console.info("Risk microphone capture", {
    requestedDeviceId: settings.microphoneDeviceId || "default",
    deviceId: inputTrack.getSettings().deviceId ?? "unknown",
    label: inputTrack.label || "unknown",
    noiseSuppression: settings.noiseSuppression,
    echoCancellation: settings.echoCancellation,
  });

  if (settings.noiseSuppression !== "rnnoise") return { inputStream, track: inputTrack };

  try {
    const rnnoise = await createRnnoiseMicrophone(inputStream);
    return { inputStream, track: rnnoise.track, rnnoise };
  } catch (error) {
    console.warn("RNNoise indisponível; usando supressão de ruído padrão do WebRTC.", error);
    await inputTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
    return { inputStream, track: inputTrack };
  }
}

async function stopMicrophoneSession(session: MicrophoneSession): Promise<void> {
  session.inputStream.getTracks().forEach((track) => track.stop());
  session.track.stop();
  await session.rnnoise?.stop().catch(() => undefined);
}

function isLinuxDesktop(): boolean {
  return Boolean(window.desktop && /Linux/i.test(navigator.userAgent));
}

async function prepareDesktopScreenAudio(excludeRisk: boolean): Promise<DesktopScreenAudioPreparation | null> {
  if (!window.desktop?.getBackendConfig) return null;
  const config = await window.desktop.getBackendConfig();
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/screen-audio/prepare`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-risk-desktop-token": config.token,
    },
    body: JSON.stringify({ excludeRisk }),
  });
  if (!response.ok) throw new Error(`Falha ao preparar áudio de tela (HTTP ${response.status}).`);
  return response.json() as Promise<DesktopScreenAudioPreparation>;
}

async function stopDesktopScreenAudio(): Promise<void> {
  if (!window.desktop?.getBackendConfig) return;
  try {
    const config = await window.desktop.getBackendConfig();
    await fetch(`${config.baseUrl.replace(/\/$/, "")}/screen-audio/stop`, {
      method: "POST",
      headers: { "x-risk-desktop-token": config.token },
    });
  } catch {
    // A parada de tela já encerra as tracks locais. O sidecar também finaliza o
    // processo pw-loopback ao ser encerrado, então este cleanup é best-effort.
  }
}

async function waitForPipeWireTrack(preparation: DesktopScreenAudioPreparation): Promise<MediaStreamTrack | undefined> {
  if (preparation.mode !== "pipewire") return undefined;
  const expectedLabel = preparation.sourceLabel?.trim().toLocaleLowerCase() ?? "";
  const expectedName = preparation.sourceName?.trim().toLocaleLowerCase() ?? "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const source = devices.find((device) => {
      if (device.kind !== "audioinput") return false;
      const label = device.label.trim().toLocaleLowerCase();
      return Boolean(label) && (
        (expectedLabel && (label === expectedLabel || label.includes(expectedLabel)))
        || (expectedName && label.includes(expectedName))
      );
    });
    if (source) {
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: source.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
        video: false,
      });
      const track = capture.getAudioTracks()[0];
      if (!track) {
        capture.getTracks().forEach((item) => item.stop());
        return undefined;
      }
      try { track.contentHint = "music"; } catch { /* contentHint é opcional */ }
      return track;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return undefined;
}

async function startDesktopVideoShare(selectedSourceId?: string): Promise<MediaStream> {
  if (!window.desktop) throw new Error("Bridge desktop indisponível para captura da tela.");
  const sourceId = selectedSourceId ?? await window.desktop.chooseScreenSource();
  if (!sourceId) throw new DOMException("Compartilhamento cancelado.", "NotAllowedError");
  await window.desktop.selectScreenSource(sourceId);
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
}

async function startPipeWireDesktopShare(preparation: DesktopScreenAudioPreparation, selectedSourceId?: string): Promise<MediaStream> {
  const stream = await startDesktopVideoShare(selectedSourceId);
  if (preparation.mode === "pipewire") {
    const audioTrack = await waitForPipeWireTrack(preparation);
    if (audioTrack) stream.addTrack(audioTrack);
  }
  return stream;
}

export function reconcileRemoteMediaState(
  streamsById: Participant["streams"],
  state: PeerState,
): PeerState {
  const streams = Object.values(streamsById ?? {});
  const videoStreams = streams.filter((stream) => stream.getVideoTracks().length > 0);
  if (!videoStreams.length) return state;

  const next = { ...state };
  const exactCamera = next.cameraStreamId ? streamsById?.[next.cameraStreamId] : undefined;
  const exactScreen = next.screenStreamId ? streamsById?.[next.screenStreamId] : undefined;

  // O msid/MediaStream.id não é garantido como uma identidade de aplicação entre
  // implementações WebRTC. Firefox/Chromium podem entregar o mesmo conjunto de
  // tracks com um id de MediaStream diferente do id anunciado pelo outro peer.
  // Quando isso acontecer, reconciliamos pela ordem/quantidade dos streams de
  // vídeo. O stream principal (microfone/câmera) chega primeiro; screen share é
  // publicado depois e portanto aparece como o último stream de vídeo.
  if (next.screenShare && !exactScreen) {
    let candidate: MediaStream | undefined;
    if (exactCamera) {
      candidate = [...videoStreams].reverse().find((stream) => stream.id !== exactCamera.id);
    } else if (!next.camera) {
      candidate = videoStreams.at(-1);
    } else if (videoStreams.length >= 2) {
      candidate = videoStreams.at(-1);
    }
    if (candidate) next.screenStreamId = candidate.id;
  }

  const normalizedScreen = next.screenStreamId ? streamsById?.[next.screenStreamId] : undefined;
  if (next.camera && !exactCamera) {
    let candidate: MediaStream | undefined;
    if (normalizedScreen) {
      candidate = videoStreams.find((stream) => stream.id !== normalizedScreen.id);
    } else if (!next.screenShare) {
      candidate = videoStreams[0];
    } else if (videoStreams.length >= 2) {
      candidate = videoStreams[0];
    }
    if (candidate) next.cameraStreamId = candidate.id;
  }

  return next;
}

export class CallController {
  private signaling?: SignalingProvider;
  private transport?: MeshWebRTCTransport;
  private local = new MediaStream();
  private readonly screen = new WebScreenShareProvider();
  private microphoneInputStream?: MediaStream;
  private microphoneTrack?: MediaStreamTrack;
  private rnnoiseMicrophone?: RnnoiseMicrophone;
  private cameraTrack?: MediaStreamTrack;
  private screenStream?: MediaStream;
  private roomId?: string;
  private peerId?: string;
  private displayName = "Participante";
  private state: PeerState = { microphone: true, camera: false, screenShare: false };
  private signalingUnsubscribers: Array<() => void> = [];
  private lifecycleId = 0;

  constructor(private readonly createSignaling: () => SignalingProvider = () => new SupabaseSignalingProvider()) {}

  async join(token: string, roomId: string, iceServers: RTCIceServer[]): Promise<MediaStream> {
    if (this.roomId) await this.leave(this.roomId);
    const lifecycle = ++this.lifecycleId;
    const voiceSettings = loadVoiceVideoSettings();
    this.roomId = roomId;
    this.peerId = crypto.randomUUID();
    this.local = new MediaStream();
    this.microphoneInputStream = undefined;
    this.microphoneTrack = undefined;
    this.rnnoiseMicrophone = undefined;
    this.cameraTrack = undefined;
    this.screenStream = undefined;
    this.state = { microphone: true, camera: false, screenShare: false };
    const store = useCallStore.getState();
    store.setError(null);
    store.setSelf(this.peerId);

    const signaling = this.createSignaling();
    this.signaling = signaling;
    const transport = new MeshWebRTCTransport(this.peerId, iceServers, {
      sendOffer: (targetPeerId, description) => signaling.sendOffer(targetPeerId, description),
      sendAnswer: (targetPeerId, description) => signaling.sendAnswer(targetPeerId, description),
      sendIce: (targetPeerId, candidate) => signaling.sendIceCandidate(targetPeerId, candidate),
      onRemoteStream: (remotePeerId, stream) => {
        const store = useCallStore.getState();
        const participant = store.participants[remotePeerId] ?? placeholderParticipant(remotePeerId);
        const streams = { ...participant.streams, [stream.id]: stream };
        const state = reconcileRemoteMediaState(streams, participant.state);
        store.upsert({ ...participant, streams, state });
      },
      onConnectionState: (remotePeerId, connection) => {
        const store = useCallStore.getState();
        const participant = store.participants[remotePeerId] ?? placeholderParticipant(remotePeerId);
        store.upsert({ ...participant, connection });
      },
    });
    this.transport = transport;
    this.bindSignaling(signaling, roomId, this.peerId);

    try {
      const profile = await api.me(token);
      if (!this.isActive(lifecycle)) throw new DOMException("Entrada na chamada cancelada.", "AbortError");
      this.displayName = profile.displayName;

      const microphoneSession = await createMicrophoneSession(voiceSettings);
      if (!this.isActive(lifecycle)) {
        await stopMicrophoneSession(microphoneSession);
        throw new DOMException("Entrada na chamada cancelada.", "AbortError");
      }

      this.microphoneInputStream = microphoneSession.inputStream;
      this.rnnoiseMicrophone = microphoneSession.rnnoise;
      this.microphoneTrack = microphoneSession.track;
      this.local.addTrack(microphoneSession.track);
      await transport.publishTrack(microphoneSession.track, this.local);
      if (!this.isActive(lifecycle)) throw new DOMException("Entrada na chamada cancelada.", "AbortError");
      this.state.cameraStreamId = this.local.id;
      this.updateLocalPreview();
      await signaling.connect(roomId, this.peerId);
      if (!this.isActive(lifecycle)) throw new DOMException("Entrada na chamada cancelada.", "AbortError");
      await Promise.all([signaling.sendPeerState(this.state), signaling.sendPeerProfile(this.displayName)]);
      return this.local;
    } catch (error) {
      if (this.isActive(lifecycle)) await this.cleanup();
      throw error;
    }
  }

  async toggleMicrophone(_roomId: string): Promise<void> {
    try {
      const track = this.microphoneTrack ?? this.local.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      this.microphoneInputStream?.getAudioTracks().forEach((input) => { input.enabled = track.enabled; });
      this.state.microphone = track.enabled;
      this.updateLocalPreview();
      await this.signaling?.sendPeerState(this.state);
    } catch (error) { this.reportError(error, "Não foi possível alterar o microfone."); }
  }

  async updateVoiceInput(settings: VoiceVideoSettings): Promise<void> {
    const lifecycle = this.lifecycleId;
    const previousTrack = this.microphoneTrack;
    const previousInputStream = this.microphoneInputStream;
    const previousRnnoise = this.rnnoiseMicrophone;
    const transport = this.transport;
    if (!previousTrack || !previousInputStream || !transport || !this.isActive(lifecycle)) {
      throw new Error("A chamada não está pronta para trocar o dispositivo de áudio.");
    }

    const replacement = await createMicrophoneSession(settings);
    if (!this.isActive(lifecycle) || this.microphoneTrack !== previousTrack) {
      await stopMicrophoneSession(replacement);
      throw new DOMException("Troca de microfone cancelada porque a chamada mudou.", "AbortError");
    }

    const syncEnabledState = () => {
      const enabled = this.state.microphone;
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

    if (!this.isActive(lifecycle)) {
      await stopMicrophoneSession(replacement);
      return;
    }

    syncEnabledState();
    this.local.removeTrack(previousTrack);
    this.local.addTrack(replacement.track);
    this.microphoneInputStream = replacement.inputStream;
    this.microphoneTrack = replacement.track;
    this.rnnoiseMicrophone = replacement.rnnoise;
    this.updateLocalPreview();

    previousInputStream.getTracks().forEach((track) => track.stop());
    previousTrack.stop();
    await previousRnnoise?.stop().catch(() => undefined);

    console.info("Risk live microphone settings applied", {
      deviceId: replacement.inputStream.getAudioTracks()[0]?.getSettings().deviceId ?? "unknown",
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      muted: !this.state.microphone,
    });
  }

  async toggleCamera(_roomId: string): Promise<void> {
    const lifecycle = this.lifecycleId;
    try {
      if (this.cameraTrack) {
        const track = this.cameraTrack;
        this.cameraTrack = undefined;
        this.state.camera = false;
        this.updateLocalPreview();
        void this.signaling?.sendPeerState(this.state).catch((error) => this.reportError(error, "Não foi possível atualizar a câmera."));
        await this.transport?.unpublishTrack(track);
        if (!this.isActive(lifecycle)) return;
        track.stop();
        this.local.removeTrack(track);
      } else {
        const cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
        const cameraTrack = cameraStream.getVideoTracks()[0];
        if (!cameraTrack) {
          cameraStream.getTracks().forEach((track) => track.stop());
          throw new Error("Nenhuma câmera foi disponibilizada pelo navegador.");
        }
        if (!this.isActive(lifecycle)) {
          cameraStream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.cameraTrack = cameraTrack;
        this.local.addTrack(cameraTrack);
        this.state.camera = true;
        this.updateLocalPreview();
        void this.signaling?.sendPeerState(this.state).catch((error) => this.reportError(error, "Não foi possível atualizar a câmera."));
        try {
          await this.transport?.publishTrack(cameraTrack, this.local);
        } catch (error) {
          if (this.cameraTrack === cameraTrack) this.cameraTrack = undefined;
          this.local.removeTrack(cameraTrack);
          cameraTrack.stop();
          this.state.camera = false;
          this.updateLocalPreview();
          void this.signaling?.sendPeerState(this.state).catch(() => undefined);
          throw error;
        }
        if (!this.isActive(lifecycle)) {
          cameraTrack.stop();
          return;
        }
      }
    } catch (error) { this.reportError(error, "Não foi possível alterar a câmera."); }
  }

  async toggleScreen(_roomId: string, sourceId?: string): Promise<void> {
    if (this.screenStream) { await this.stopScreen(); return; }
    const lifecycle = this.lifecycleId;
    let desktopAudio: DesktopScreenAudioPreparation | null = null;
    let linuxAudioPreparation: Promise<DesktopScreenAudioPreparation | null> | undefined;
    let stream: MediaStream | undefined;
    try {
      const voiceSettings = loadVoiceVideoSettings();
      const linuxDesktop = isLinuxDesktop();

      if (linuxDesktop) {
        // Não bloqueia o vídeo esperando PipeWire. O áudio é anexado depois, se
        // a fonte virtual ficar disponível, sem interromper microfone/chamada.
        linuxAudioPreparation = prepareDesktopScreenAudio(voiceSettings.excludeRiskAudioFromScreenShare).catch((error) => {
          console.warn("Não foi possível preparar o áudio PipeWire da tela.", error);
          return null;
        });
        stream = await startDesktopVideoShare(sourceId);
      } else {
        desktopAudio = await prepareDesktopScreenAudio(voiceSettings.excludeRiskAudioFromScreenShare).catch((error) => {
          console.warn("Não foi possível consultar o backend de áudio de tela; usando captura padrão.", error);
          return null;
        });
        const pipeWireDesktop = desktopAudio?.mode === "pipewire" || desktopAudio?.mode === "unavailable";
        stream = pipeWireDesktop
          ? await startPipeWireDesktopShare(desktopAudio!, sourceId)
          : await this.screen.startScreenShare(sourceId);
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("A fonte selecionada não forneceu vídeo");
      }

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
      if (screenAudioTrack && voiceSettings.excludeRiskAudioFromScreenShare) {
        if (desktopAudio?.mode === "pipewire" && desktopAudio.excludedRisk) {
          console.info("Risk screen audio exclusion active", {
            mode: "pipewire-node-exclusion",
            source: desktopAudio.sourceName ?? desktopAudio.sourceLabel ?? "unknown",
          });
        } else {
          const settings = screenAudioTrack.getSettings() as DisplayAudioSettings;
          const nativeRiskExclusion = settings.deviceId === "loopbackWithoutChrome";
          const browserRiskExclusion = settings.restrictOwnAudio === true;
          if (nativeRiskExclusion || browserRiskExclusion) {
            console.info("Risk screen audio exclusion active", {
              deviceId: settings.deviceId ?? "unknown",
              restrictOwnAudio: settings.restrictOwnAudio ?? false,
              mode: nativeRiskExclusion ? "native-process-loopback" : "restrictOwnAudio",
            });
          } else {
            console.warn("A captura de tela não confirmou a exclusão do áudio do Risk.", {
              deviceId: settings.deviceId ?? "unknown",
              restrictOwnAudio: settings.restrictOwnAudio ?? false,
            });
          }
        }
      }

      if (!this.isActive(lifecycle)) {
        stream.getTracks().forEach((track) => track.stop());
        await stopDesktopScreenAudio();
        return;
      }
      this.screenStream = stream;
      videoTrack.addEventListener("ended", () => { void this.stopScreen(); }, { once: true });
      const transport = this.transport;
      if (!transport) {
        stream.getTracks().forEach((track) => track.stop());
        await stopDesktopScreenAudio();
        this.screenStream = undefined;
        return;
      }

      this.state.screenShare = true;
      this.state.screenStreamId = stream.id;
      this.state.screenAudio = stream.getAudioTracks().length > 0;
      this.updateLocalPreview();
      void this.signaling?.sendPeerState(this.state).catch((error) => this.reportError(error, "Não foi possível atualizar o compartilhamento de tela."));

      // No Linux o stream começa somente com vídeo. Isso faz a transmissão aparecer
      // imediatamente; o áudio PipeWire entra depois por uma renegociação separada.
      await Promise.all(stream.getTracks().map((track) => transport.publishTrack(track, stream!)));
      if (!this.isActive(lifecycle)) {
        stream.getTracks().forEach((track) => track.stop());
        await stopDesktopScreenAudio();
        return;
      }

      // Reafirma a track do microfone sem renegociar se ela já estiver publicada.
      // Isso protege contra implementações que alterem senders durante addTrack.
      const microphone = this.microphoneTrack;
      if (microphone?.readyState === "live") await transport.publishTrack(microphone, this.local);

      if (linuxAudioPreparation) {
        void this.attachLinuxScreenAudio(stream, lifecycle, linuxAudioPreparation, voiceSettings.excludeRiskAudioFromScreenShare);
      }
    } catch (error) {
      if (linuxAudioPreparation) {
        void linuxAudioPreparation.then(() => stopDesktopScreenAudio()).catch(() => undefined);
      }
      if (stream && this.screenStream === stream) await this.stopScreen().catch(() => undefined);
      else if (desktopAudio?.mode === "pipewire") await stopDesktopScreenAudio();
      if (!(error instanceof DOMException && error.name === "NotAllowedError")) this.reportError(error, "Não foi possível compartilhar a tela.");
    }
  }

  async leave(_roomId: string): Promise<void> { await this.cleanup(); }

  getDiagnostics(): CallDiagnostics {
    return {
      signaling: this.signaling?.getDiagnostics() ?? null,
      peerConnections: this.transport?.getDiagnostics() ?? [],
    };
  }

  private async attachLinuxScreenAudio(
    stream: MediaStream,
    lifecycle: number,
    preparationPromise: Promise<DesktopScreenAudioPreparation | null>,
    excludeRisk: boolean,
  ): Promise<void> {
    try {
      const preparation = await preparationPromise;
      if (!this.isActive(lifecycle) || this.screenStream !== stream) {
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
      if (!this.isActive(lifecycle) || this.screenStream !== stream) {
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
      this.state.screenAudio = true;
      this.updateLocalPreview();
      void this.signaling?.sendPeerState(this.state).catch((error) => this.reportError(error, "Não foi possível atualizar o áudio da tela."));

      const transport = this.transport;
      if (!transport) {
        stream.removeTrack(audioTrack);
        audioTrack.stop();
        this.state.screenAudio = false;
        this.updateLocalPreview();
        return;
      }

      try {
        await transport.publishTrack(audioTrack, stream);
        const microphone = this.microphoneTrack;
        if (microphone?.readyState === "live") await transport.publishTrack(microphone, this.local);
      } catch (error) {
        stream.removeTrack(audioTrack);
        audioTrack.stop();
        this.state.screenAudio = false;
        this.updateLocalPreview();
        void this.signaling?.sendPeerState(this.state).catch(() => undefined);
        this.reportError(error, "Não foi possível transmitir o áudio da tela.");
      }
    } catch (error) {
      console.warn("Falha ao anexar áudio PipeWire à transmissão.", error);
    }
  }

  private bindSignaling(signaling: SignalingProvider, roomId: string, peerId: string): void {
    this.signalingUnsubscribers.push(
      signaling.onPeerJoined((peer) => {
        const store = useCallStore.getState();
        const participant = store.participants[peer.peerId] ?? placeholderParticipant(peer.peerId);
        store.upsert({ ...participant, connection: participant.connection ?? "new" });
        void this.transport?.connect(peer.peerId, peerId < peer.peerId).catch((error) => store.setError(String(error)));
        void signaling.sendPeerState(this.state).catch((error) => store.setError(String(error)));
        void signaling.sendPeerProfile(this.displayName).catch((error) => store.setError(String(error)));
      }),
      signaling.onPeerLeft((remotePeerId) => {
        useCallStore.getState().remove(remotePeerId);
        void this.transport?.disconnect(remotePeerId);
      }),
      signaling.onOffer((message) => {
        void this.transport?.acceptOffer(message.fromPeerId, message.payload.sdp).catch((error) => useCallStore.getState().setError(String(error)));
      }),
      signaling.onAnswer((message) => {
        void this.transport?.acceptAnswer(message.fromPeerId, message.payload.sdp).catch((error) => useCallStore.getState().setError(String(error)));
      }),
      signaling.onIceCandidate((message) => {
        void this.transport?.addIceCandidate(message.fromPeerId, message.payload.candidate).catch((error) => useCallStore.getState().setError(String(error)));
      }),
      signaling.onPeerState((message) => {
        const store = useCallStore.getState();
        const participant = store.participants[message.fromPeerId] ?? placeholderParticipant(message.fromPeerId);
        const state = reconcileRemoteMediaState(participant.streams, message.payload.state);
        store.upsert({ ...participant, state });
      }),
      signaling.onPeerProfile((message) => {
        const store = useCallStore.getState();
        const participant = store.participants[message.fromPeerId] ?? placeholderParticipant(message.fromPeerId);
        store.upsert({ ...participant, displayName: message.payload.displayName });
      }),
      signaling.onStatusChange((status) => {
        if (status === "error") useCallStore.getState().setError("Falha no signaling Supabase Realtime.");
      }),
    );
    void roomId;
  }

  private async stopScreen(): Promise<void> {
    const stream = this.screenStream;
    if (!stream) return;
    this.screenStream = undefined;
    this.state.screenShare = false;
    this.state.screenStreamId = undefined;
    this.state.screenAudio = false;
    this.updateLocalPreview();
    void this.signaling?.sendPeerState(this.state).catch((error) => this.reportError(error, "Não foi possível atualizar o compartilhamento de tela."));
    const transport = this.transport;
    if (transport) await Promise.all(stream.getTracks().map((track) => transport.unpublishTrack(track).catch(() => undefined)));
    stream.getTracks().forEach((track) => track.stop());
    await this.screen.stopScreenShare().catch(() => undefined);
    await stopDesktopScreenAudio();
  }

  private updateLocalPreview(): void {
    useCallStore.getState().setLocalMedia({
      camera: this.cameraTrack ? new MediaStream([this.cameraTrack]) : null,
      screen: this.screenStream ? new MediaStream(this.screenStream.getVideoTracks()) : null,
    }, this.state);
  }

  private isActive(lifecycle: number): boolean {
    return lifecycle === this.lifecycleId && Boolean(this.roomId && this.transport && this.signaling);
  }

  private reportError(error: unknown, fallback: string): void {
    const message = error instanceof Error ? error.message : fallback;
    useCallStore.getState().setError(message || fallback);
  }

  private async cleanup(): Promise<void> {
    this.lifecycleId += 1;
    const signaling = this.signaling;
    const transport = this.transport;
    const local = this.local;
    const rnnoiseMicrophone = this.rnnoiseMicrophone;
    const microphoneInputStream = this.microphoneInputStream;
    const screenStream = this.screenStream;
    const unsubscribers = this.signalingUnsubscribers.splice(0);

    // O estado é destacado antes dos awaits para impedir que um cleanup antigo
    // apague a sessão criada por um join posterior.
    this.signaling = undefined;
    this.transport = undefined;
    this.local = new MediaStream();
    this.microphoneInputStream = undefined;
    this.microphoneTrack = undefined;
    this.rnnoiseMicrophone = undefined;
    this.cameraTrack = undefined;
    this.screenStream = undefined;
    this.roomId = undefined;
    this.peerId = undefined;
    this.displayName = "Participante";
    this.state = { microphone: true, camera: false, screenShare: false };

    unsubscribers.forEach((unsubscribe) => unsubscribe());
    local.getTracks().forEach((track) => track.stop());
    microphoneInputStream?.getTracks().forEach((track) => track.stop());
    screenStream?.getTracks().forEach((track) => track.stop());
    const screenCleanup = this.screen.stopScreenShare().catch(() => undefined);
    const desktopAudioCleanup = stopDesktopScreenAudio();

    const store = useCallStore.getState();
    store.clearParticipants();
    store.setLocalMedia({ camera: null, screen: null }, this.state);

    await signaling?.disconnect().catch(() => undefined);
    await transport?.disconnect().catch(() => undefined);
    await rnnoiseMicrophone?.stop().catch(() => undefined);
    await screenCleanup;
    await desktopAudioCleanup;
  }
}
