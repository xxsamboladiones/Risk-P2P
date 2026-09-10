import { RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_THEME_SETTINGS,
  loadThemeSettings,
  saveThemeSettings,
  selectThemePreset,
  THEME_PRESETS,
  type ThemeColors,
  type ThemeSettings,
} from "../services/theme/settings";
import "./appearance-settings.css";

const COLOR_FIELDS: ReadonlyArray<{ key: keyof ThemeColors; label: string }> = [
  { key: "accent", label: "Destaque" },
  { key: "background", label: "Fundo principal" },
  { key: "navigation", label: "Navegação" },
  { key: "surface", label: "Painéis" },
  { key: "elevated", label: "Elementos elevados" },
  { key: "text", label: "Texto principal" },
  { key: "muted", label: "Texto secundário" },
  { key: "success", label: "Sucesso/conectado" },
  { key: "warning", label: "Avisos" },
  { key: "danger", label: "Erros/perigo" },
];

export function AppearanceSettingsPanel() {
  const [settings, setSettings] = useState<ThemeSettings>(() => loadThemeSettings());

  function choosePreset(id: typeof THEME_PRESETS[number]["id"]): void {
    setSettings(selectThemePreset(id));
  }

  function updateColor(key: keyof ThemeColors, value: string): void {
    setSettings(saveThemeSettings({
      preset: "custom",
      colors: { ...settings.colors, [key]: value },
    }));
  }

  function reset(): void {
    setSettings(saveThemeSettings({
      preset: DEFAULT_THEME_SETTINGS.preset,
      colors: { ...DEFAULT_THEME_SETTINGS.colors },
    }));
  }

  return <div className="appearance-settings">
    <section>
      <header><strong>Temas prontos</strong><small>Escolha uma base e personalize qualquer cor abaixo.</small></header>
      <div className="theme-preset-grid">
        {THEME_PRESETS.map((preset) => <button
          type="button"
          key={preset.id}
          className={settings.preset === preset.id ? "active" : ""}
          onClick={() => choosePreset(preset.id)}
        >
          <span className="theme-preset-colors">
            <i style={{ background: preset.colors.background }}/>
            <i style={{ background: preset.colors.surface }}/>
            <i style={{ background: preset.colors.accent }}/>
            <i style={{ background: preset.colors.success }}/>
          </span>
          <strong>{preset.name}</strong>
        </button>)}
      </div>
    </section>

    <section>
      <header><strong>Cores personalizadas</strong><small>As mudanças aparecem imediatamente em todo o aplicativo.</small></header>
      <div className="theme-color-grid">
        {COLOR_FIELDS.map((field) => <label key={field.key}>
          <span>{field.label}</span>
          <span className="theme-color-input">
            <input
              type="color"
              value={settings.colors[field.key]}
              onChange={(event) => updateColor(field.key, event.target.value)}
              aria-label={field.label}
            />
            <code>{settings.colors[field.key].toUpperCase()}</code>
          </span>
        </label>)}
      </div>
    </section>

    <button type="button" className="settings-secondary-button theme-reset" onClick={reset}>
      <RotateCcw size={16}/>Restaurar tema Risk
    </button>
    <div className="settings-note">O tema fica salvo somente neste dispositivo. O contraste dos textos sobre a cor de destaque é ajustado automaticamente.</div>
  </div>;
}
