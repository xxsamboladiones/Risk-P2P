import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const themeStyles = readFileSync(new URL("./theme-overrides.css", import.meta.url), "utf8");
const baseStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("prioridade visual dos temas", () => {
  it("não transforma controles transparentes da navegação em botões primários", () => {
    expect(themeStyles).toContain(":where(html[data-risk-theme]) button");
    expect(themeStyles).not.toMatch(/html\[data-risk-theme\]\s+button\s*\{/);
    expect(baseStyles).toMatch(/\.channel\{[^}]*background:none/);
    expect(baseStyles).toMatch(/\.member-menu-trigger\{[^}]*background:transparent/);
    expect(baseStyles).toMatch(/\.voice-session-summary\{[^}]*background:transparent/);
  });

  it("mantém cores globais com prioridade menor que os estados dos componentes", () => {
    expect(themeStyles).toContain(":where(html[data-risk-theme]) input");
    expect(themeStyles).toContain(":where(html[data-risk-theme]) small");
    expect(themeStyles).toMatch(/\.channel\.voice\.connected[^}]*color:var\(--risk-success\)/);
  });
});
