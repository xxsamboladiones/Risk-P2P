export type NoiseSuppressionMode = "rnnoise" | "standard" | "off";

export type VoiceVideoSettings = {
  noiseSuppression: NoiseSuppressionMode;
  echoCancellation: boolean;
  excludeRiskAudioFromScreenShare: boolean;
};

type RiskMediaCaptureOptions = {
  restrictOwnAudio: boolean;
};

const STORAGE_KEY = "risk.voice-video-settings.v1";

export const DEFAULT_VOICE_VIDEO_SETTINGS: VoiceVideoSettings = {
  noiseSuppression: "rnnoise",
  echoCancellation: true,
  excludeRiskAudioFromScreenShare: true,
};

function syncMediaCaptureOptions(settings: VoiceVideoSettings): void {
  (globalThis as typeof globalThis & { __riskMediaCaptureOptions?: RiskMediaCaptureOptions }).__riskMediaCaptureOptions = {
    restrictOwnAudio: settings.excludeRiskAudioFromScreenShare,
  };
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
    const noiseSuppression: NoiseSuppressionMode = value.noiseSuppression === "standard" || value.noiseSuppression === "off"
      ? value.noiseSuppression
      : "rnnoise";
    const settings: VoiceVideoSettings = {
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  syncMediaCaptureOptions(settings);
  window.dispatchEvent(new CustomEvent<VoiceVideoSettings>("risk:voice-video-settings", { detail: settings }));
}
