export type ThemeColors = {
  accent: string;
  background: string;
  navigation: string;
  surface: string;
  elevated: string;
  text: string;
  muted: string;
  success: string;
  warning: string;
  danger: string;
};

export type ThemePresetId = "risk" | "ocean" | "violet" | "sunset" | "rose" | "light" | "custom";

export type ThemeSettings = {
  preset: ThemePresetId;
  colors: ThemeColors;
};

export type ThemePreset = {
  id: Exclude<ThemePresetId, "custom">;
  name: string;
  colors: ThemeColors;
};

const STORAGE_KEY = "risk.theme-settings.v1";
export const THEME_SETTINGS_EVENT = "risk:theme-settings";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "risk",
    name: "Risk",
    colors: { accent: "#b7f66a", background: "#090b10", navigation: "#10141b", surface: "#151a22", elevated: "#202731", text: "#edf1f7", muted: "#8994a3", success: "#75df8c", warning: "#e2c55f", danger: "#e95555" },
  },
  {
    id: "ocean",
    name: "Oceano",
    colors: { accent: "#59c7ff", background: "#071018", navigation: "#0b1823", surface: "#102332", elevated: "#183246", text: "#eef8ff", muted: "#8aa4b7", success: "#5be3ad", warning: "#f1c75b", danger: "#ff6577" },
  },
  {
    id: "violet",
    name: "Violeta",
    colors: { accent: "#b996ff", background: "#0d0914", navigation: "#171020", surface: "#21172d", elevated: "#302141", text: "#f7f0ff", muted: "#a394b2", success: "#79dfa0", warning: "#efc76b", danger: "#f06a8a" },
  },
  {
    id: "sunset",
    name: "Pôr do sol",
    colors: { accent: "#ffad5c", background: "#130b0a", navigation: "#201211", surface: "#2b1916", elevated: "#3d241e", text: "#fff4eb", muted: "#b29a8d", success: "#7ddb91", warning: "#ffd166", danger: "#ff6464" },
  },
  {
    id: "rose",
    name: "Rosa",
    colors: { accent: "#ff83bd", background: "#120910", navigation: "#1d101a", surface: "#291723", elevated: "#3a2132", text: "#fff1f8", muted: "#b299a8", success: "#78dda2", warning: "#eac96b", danger: "#ff667a" },
  },
  {
    id: "light",
    name: "Claro",
    colors: { accent: "#527d10", background: "#eef2f6", navigation: "#e2e8ee", surface: "#ffffff", elevated: "#d5dde6", text: "#17202a", muted: "#617080", success: "#247a46", warning: "#936d08", danger: "#b83243" },
  },
] as const;

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  preset: "risk",
  colors: { ...THEME_PRESETS[0]!.colors },
};

export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function normalizedColors(value: unknown, fallback: ThemeColors): ThemeColors {
  const candidate = value && typeof value === "object" ? value as Partial<ThemeColors> : {};
  return Object.fromEntries(Object.entries(fallback).map(([key, fallbackColor]) => {
    const color = candidate[key as keyof ThemeColors];
    return [key, isThemeColor(color) ? color.toLowerCase() : fallbackColor];
  })) as ThemeColors;
}

function presetById(value: unknown): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === value);
}

export function loadThemeSettings(): ThemeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THEME_SETTINGS, colors: { ...DEFAULT_THEME_SETTINGS.colors } };
    const value = JSON.parse(raw) as Partial<ThemeSettings>;
    const preset = value.preset === "custom" ? undefined : presetById(value.preset);
    if (preset) return { preset: preset.id, colors: { ...preset.colors } };
    return { preset: "custom", colors: normalizedColors(value.colors, DEFAULT_THEME_SETTINGS.colors) };
  } catch {
    return { ...DEFAULT_THEME_SETTINGS, colors: { ...DEFAULT_THEME_SETTINGS.colors } };
  }
}

export function saveThemeSettings(settings: ThemeSettings): ThemeSettings {
  const preset = settings.preset === "custom" ? undefined : presetById(settings.preset);
  const normalized: ThemeSettings = preset
    ? { preset: preset.id, colors: { ...preset.colors } }
    : { preset: "custom", colors: normalizedColors(settings.colors, DEFAULT_THEME_SETTINGS.colors) };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* mantém o tema em memória */ }
  applyTheme(normalized);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ThemeSettings>(THEME_SETTINGS_EVENT, { detail: normalized }));
  }
  return normalized;
}

export function selectThemePreset(id: ThemePreset["id"]): ThemeSettings {
  const preset = presetById(id) ?? THEME_PRESETS[0]!;
  return saveThemeSettings({ preset: preset.id, colors: { ...preset.colors } });
}

export function applyTheme(settings: ThemeSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const colors = settings.colors;
  const variables: Record<string, string> = {
    "--risk-accent": colors.accent,
    "--risk-background": colors.background,
    "--risk-navigation": colors.navigation,
    "--risk-surface": colors.surface,
    "--risk-elevated": colors.elevated,
    "--risk-text": colors.text,
    "--risk-muted": colors.muted,
    "--risk-success": colors.success,
    "--risk-warning": colors.warning,
    "--risk-danger": colors.danger,
    "--risk-accent-contrast": contrastColor(colors.accent),
    "--risk-surface-contrast": contrastColor(colors.surface),
    "--risk-border": withAlpha(colors.text, 18),
    "--risk-border-strong": withAlpha(colors.text, 34),
    "--risk-accent-soft": withAlpha(colors.accent, 18),
    "--risk-accent-medium": withAlpha(colors.accent, 42),
    "--risk-success-soft": withAlpha(colors.success, 20),
    "--risk-warning-soft": withAlpha(colors.warning, 20),
    "--risk-danger-soft": withAlpha(colors.danger, 20),
    "--risk-overlay": withAlpha(colors.background, 218),
    "--risk-shadow": withAlpha(contrastColor(colors.background), 90),
  };
  Object.entries(variables).forEach(([name, value]) => root.style.setProperty(name, value));
  root.dataset.riskTheme = settings.preset;
  root.style.colorScheme = relativeLuminance(colors.background) > 0.55 ? "light" : "dark";
}

export function initializeTheme(): ThemeSettings {
  const settings = loadThemeSettings();
  applyTheme(settings);
  return settings;
}

function withAlpha(hex: string, alpha: number): string {
  return `${hex}${Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, "0")}`;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastColor(background: string): string {
  return relativeLuminance(background) > 0.42 ? "#071008" : "#ffffff";
}
