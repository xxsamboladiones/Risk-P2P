export type NoiseSuppressionMode = "rnnoise" | "standard" | "off";

export type VoiceVideoSettings = {
  microphoneDeviceId: string;
  noiseSuppression: NoiseSuppressionMode;
  echoCancellation: boolean;
  excludeRiskAudioFromScreenShare: boolean;
};

type RiskMediaCaptureOptions = {
  restrictOwnAudio: boolean;
};

const STORAGE_KEY = "risk.voice-video-settings.v1";
const MAX_DEVICE_ID_LENGTH = 512;

export const DEFAULT_VOICE_VIDEO_SETTINGS: VoiceVideoSettings = {
  microphoneDeviceId: "",
  noiseSuppression: "standard",
  echoCancellation: true,
  excludeRiskAudioFromScreenShare: true,
};

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
      const settings = { ...DEFAULT_VOICE_VIDEO_SETTINGS };
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
      excludeRiskAudioFromScreenShare: value.excludeRiskAudioFromScreenShare !== false,
    };
    syncMediaCaptureOptions(settings);
    return settings;
  } catch {
    const settings = { ...DEFAULT_VOICE_VIDEO_SETTINGS };
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
  window.dispatchEvent(new CustomEvent<VoiceVideoSettings>("risk:voice-video-settings", { detail: normalized }));
}
