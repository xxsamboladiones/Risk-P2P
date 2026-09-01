import { describe, expect, it } from "vitest";
import { shouldHideWindowOnClose } from "./desktop-lifecycle.js";

describe("ciclo da janela desktop", () => {
  it("esconde uma janela normal quando a bandeja está disponível", () => {
    expect(shouldHideWindowOnClose({ isQuitting: false, trayAvailable: true, automatedRun: false })).toBe(true);
  });

  it("permite fechar durante encerramento e reinicialização", () => {
    expect(shouldHideWindowOnClose({ isQuitting: true, trayAvailable: true, automatedRun: false })).toBe(false);
  });

  it("não deixa um processo invisível se a bandeja falhar", () => {
    expect(shouldHideWindowOnClose({ isQuitting: false, trayAvailable: false, automatedRun: false })).toBe(false);
  });

  it("não interfere na verificação automatizada do pacote", () => {
    expect(shouldHideWindowOnClose({ isQuitting: false, trayAvailable: true, automatedRun: true })).toBe(false);
  });
});
