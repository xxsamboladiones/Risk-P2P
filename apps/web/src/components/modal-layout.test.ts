import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modalSource = readFileSync(new URL("./Modal.tsx", import.meta.url), "utf8");
const modalStyles = readFileSync(new URL("./modal-layout.css", import.meta.url), "utf8");

describe("layout responsivo dos modais", () => {
  it("separa o cabeçalho fixo do conteúdo rolável", () => {
    expect(modalSource).toContain('className="modal-header"');
    expect(modalSource).toContain('className="modal-content"');
    expect(modalStyles).toMatch(/\.modal\s*\{[^}]*max-height:[^}]*100dvh[^}]*overflow:\s*hidden/s);
    expect(modalStyles).toMatch(/\.modal-content\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  });

  it("mantém as abas das configurações visíveis durante a rolagem", () => {
    expect(modalStyles).toMatch(/\.modal-content\s*>\s*\.settings-tabs\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
  });
});
