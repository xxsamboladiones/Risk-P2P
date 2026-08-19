export type NoiseSuppressionMode = "rnnoise" | "standard" | "off";

export type VoiceVideoSettings = {
  noiseSuppression: NoiseSuppressionMode;
  echoCancellation: boolean;
  excludeRiskAudioFromScreenShare: boolean;
};

const STORAGE_KEY = "risk.voice-video-settings.v1";

export const DEFAULT_VOICE_VIDEO_SETTINGS: VoiceVideoSettings = {
  noiseSuppression: "rnnoise",
  echoCancellation: true,
  excludeRiskAudioFromScreenShare: true,
};

export function loadVoiceVideoSettings(): VoiceVideoSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VOICE_VIDEO_SETTINGS };
    const value = JSON.parse(raw) as Partial<VoiceVideoSettings>;
    const noiseSuppression: NoiseSuppressionMode = value.noiseSuppression === "standard" || value.noiseSuppression === "off"
      ? value.noiseSuppression
      : "rnnoise";
    return {
      noiseSuppression,
      echoCancellation: value.echoCancellation !== false,
      excludeRiskAudioFromScreenShare: value.excludeRiskAudioFromScreenShare !== false,
    };
  } catch {
    return { ...DEFAULT_VOICE_VIDEO_SETTINGS };
  }
}

export function saveVoiceVideoSettings(settings: VoiceVideoSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent<VoiceVideoSettings>("risk:voice-video-settings", { detail: settings }));
}
