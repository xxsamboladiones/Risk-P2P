import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  DEFAULT_THEME_SETTINGS,
  loadThemeSettings,
  saveThemeSettings,
  selectThemePreset,
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
