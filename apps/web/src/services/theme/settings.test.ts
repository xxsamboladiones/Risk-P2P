import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  DEFAULT_THEME_SETTINGS,
  loadThemeSettings,
  saveThemeSettings,
  selectThemePreset,
  THEME_PRESETS,
} from "./settings";

const values = new Map<string, string>();
const properties = new Map<string, string>();
const documentElement = {
  dataset: {} as Record<string, string>,
  style: {
    colorScheme: "",
    setProperty: (name: string, value: string) => properties.set(name, value),
  },
};

beforeEach(() => {
  values.clear();
  properties.clear();
  documentElement.dataset = {};
  documentElement.style.colorScheme = "";
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("document", { documentElement });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("CustomEvent", class<T> extends Event {
    constructor(type: string, readonly init: CustomEventInit<T>) { super(type); }
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("theme settings", () => {
  it("aplica todos os tokens do tema padrão", () => {
    applyTheme(loadThemeSettings());
    expect(properties.get("--risk-accent")).toBe(DEFAULT_THEME_SETTINGS.colors.accent);
    expect(properties.get("--risk-background")).toBe(DEFAULT_THEME_SETTINGS.colors.background);
    expect(properties.get("--risk-danger")).toBe(DEFAULT_THEME_SETTINGS.colors.danger);
    expect(documentElement.dataset.riskTheme).toBe("risk");
  });

  it("seleciona e persiste uma predefinição completa", () => {
    const theme = selectThemePreset("ocean");
    expect(theme.preset).toBe("ocean");
    expect(properties.get("--risk-accent")).toBe("#59c7ff");
    expect(JSON.parse([...values.values()][0]!).preset).toBe("ocean");
  });

  it("oferece um tema All Black com fundo preto absoluto e contraste escuro", () => {
    const theme = selectThemePreset("all-black");

    expect(theme.preset).toBe("all-black");
    expect(theme.colors.background).toBe("#000000");
    expect(theme.colors.navigation).toBe("#030303");
    expect(documentElement.style.colorScheme).toBe("dark");
    expect(properties.get("--risk-accent-contrast")).toBe("#071008");
  });

  it("mantém identificadores e cores válidos em todas as predefinições", () => {
    expect(new Set(THEME_PRESETS.map((preset) => preset.id)).size).toBe(THEME_PRESETS.length);
    for (const preset of THEME_PRESETS) {
      expect(Object.values(preset.colors)).toHaveLength(10);
      expect(Object.values(preset.colors).every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    }
  });

  it("aceita cores personalizadas e recupera valores inválidos", () => {
    const theme = saveThemeSettings({
      preset: "custom",
      colors: { ...DEFAULT_THEME_SETTINGS.colors, accent: "#123456", danger: "inválida" },
    });
    expect(theme.preset).toBe("custom");
    expect(theme.colors.accent).toBe("#123456");
    expect(theme.colors.danger).toBe(DEFAULT_THEME_SETTINGS.colors.danger);
  });
});
