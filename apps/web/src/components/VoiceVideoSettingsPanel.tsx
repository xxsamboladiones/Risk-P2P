import { useState } from "react";
import {
  loadVoiceVideoSettings,
  saveVoiceVideoSettings,
  type NoiseSuppressionMode,
  type VoiceVideoSettings,
} from "../services/audio/settings";
import "./voice-video-settings.css";

export function VoiceVideoSettingsPanel() {
  const [settings, setSettings] = useState<VoiceVideoSettings>(() => loadVoiceVideoSettings());
  const [saved, setSaved] = useState(false);

  function update(patch: Partial<VoiceVideoSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  function save() {
    saveVoiceVideoSettings(settings);
    setSaved(true);
  }

  return <div className="voice-video-settings">
    <label className="settings-field">
      <span>Supressão de ruído</span>
      <select
        value={settings.noiseSuppression}
        onChange={(event) => update({ noiseSuppression: event.target.value as NoiseSuppressionMode })}
      >
        <option value="standard">Padrão do WebRTC — recomendado</option>
        <option value="rnnoise">RNNoise — experimental</option>
        <option value="off">Desativada</option>
      </select>
      <small>O modo padrão é o mais compatível. RNNoise processa a voz localmente em um AudioWorklet e volta automaticamente ao WebRTC se não conseguir iniciar.</small>
    </label>

    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={settings.echoCancellation}
        onChange={(event) => update({ echoCancellation: event.target.checked })}
      />
      <span><strong>Cancelamento de eco</strong><small>Evita que o áudio dos alto-falantes volte pelo microfone.</small></span>
    </label>

    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={settings.excludeRiskAudioFromScreenShare}
        onChange={(event) => update({ excludeRiskAudioFromScreenShare: event.target.checked })}
      />
      <span><strong>Excluir áudio do Risk da transmissão</strong><small>Ao compartilhar a tela, tenta capturar o PC sem retransmitir as vozes reproduzidas pelo próprio Risk.</small></span>
    </label>

    <div className="settings-note">Mudanças de microfone entram em vigor na próxima entrada em uma sala de voz. A exclusão do áudio do Risk vale no próximo compartilhamento de tela.</div>
    <button onClick={save}>{saved ? "Configurações salvas" : "Salvar configurações"}</button>
  </div>;
}