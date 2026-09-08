import type { VoiceVideoSettings } from "./settings";

function constraintsFor(settings: VoiceVideoSettings, deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression === "standard",
    // O AGC do Chromium pode recalibrar o nível quando uma segunda captura de
    // áudio (a tela) desaparece, elevando bruscamente a sensibilidade do mic.
    autoGainControl: false,
    channelCount: 1,
  };
}

function isUnavailableDeviceError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "NotFoundError" || name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError";
}

export async function openConfiguredMicrophone(settings: VoiceVideoSettings): Promise<MediaStream> {
  const selectedDeviceId = settings.microphoneDeviceId.trim();
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: constraintsFor(settings, selectedDeviceId || undefined),
      video: false,
    });
  } catch (error) {
    if (!selectedDeviceId || !isUnavailableDeviceError(error)) throw error;
    console.warn("O microfone selecionado não está disponível; usando o dispositivo padrão do sistema.", {
      deviceId: selectedDeviceId,
      error,
    });
    return navigator.mediaDevices.getUserMedia({
      audio: constraintsFor(settings),
      video: false,
    });
  }
}
