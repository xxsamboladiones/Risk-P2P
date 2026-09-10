export type NoiseSuppressionMode = "rnnoise" | "standard" | "off";

export type VoiceVideoSettings = {
  microphoneDeviceId: string;
  noiseSuppression: NoiseSuppressionMode;
  echoCancellation: boolean;
  automaticGainControl: boolean;
  excludeRiskAudioFromScreenShare: boolean;
};

type RiskMediaCaptureOptions = {
  restrictOwnAudio: boolean;
};

const STORAGE_KEY = "risk.voice-video-settings.v1";
export const VOICE_VIDEO_SETTINGS_EVENT = "risk:voice-video-settings";
const MAX_DEVICE_ID_LENGTH = 512;

export const DEFAULT_VOICE_VIDEO_SETTINGS: VoiceVideoSettings = {
  microphoneDeviceId: "",
  noiseSuppression: "standard",
  echoCancellation: true,
  automaticGainControl: false,
  excludeRiskAudioFromScreenShare: true,
};

function runtimeAutomaticGainControlDefault(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

function defaultSettings(): VoiceVideoSettings {
  return {
    ...DEFAULT_VOICE_VIDEO_SETTINGS,
    // O AGC ajuda drivers Windows que entregam sinal digital muito baixo. No
    // Linux ele continua desligado para não alterar o ganho físico do PipeWire.
    automaticGainControl: runtimeAutomaticGainControlDefault(),
  };
}

function syncMediaCaptureOptions(settings: VoiceVideoSettings): void {
  (globalThis as typeof globalThis & { __riskMediaCaptureOptions?: RiskMediaCaptureOptions }).__riskMediaCaptureOptions = {
    restrictOwnAudio: settings.excludeRiskAudioFromScreenShare,
  };
}

function normalizeMicrophoneDeviceId(value: unknown): string {
  return typeof value === "string" && value.length <= MAX_DEVICE_ID_LENGTH ? value : "";
}

export function loadVoiceVideoSettings(): VoiceVideoSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const settings = defaultSettings();
      syncMediaCaptureOptions(settings);
      return settings;
    }
    const value = JSON.parse(raw) as Partial<VoiceVideoSettings>;
    const noiseSuppression: NoiseSuppressionMode = value.noiseSuppression === "rnnoise" || value.noiseSuppression === "off"
      ? value.noiseSuppression
      : "standard";
    const settings: VoiceVideoSettings = {
      microphoneDeviceId: normalizeMicrophoneDeviceId(value.microphoneDeviceId),
      noiseSuppression,
      echoCancellation: value.echoCancellation !== false,
      automaticGainControl: typeof value.automaticGainControl === "boolean"
        ? value.automaticGainControl
        : runtimeAutomaticGainControlDefault(),
      excludeRiskAudioFromScreenShare: value.excludeRiskAudioFromScreenShare !== false,
    };
    syncMediaCaptureOptions(settings);
    return settings;
  } catch {
    const settings = defaultSettings();
    syncMediaCaptureOptions(settings);
    return settings;
  }
}

export function saveVoiceVideoSettings(settings: VoiceVideoSettings): void {
  const normalized: VoiceVideoSettings = {
    ...settings,
    microphoneDeviceId: normalizeMicrophoneDeviceId(settings.microphoneDeviceId),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  syncMediaCaptureOptions(normalized);
  window.dispatchEvent(new CustomEvent<VoiceVideoSettings>(VOICE_VIDEO_SETTINGS_EVENT, { detail: normalized }));
}
