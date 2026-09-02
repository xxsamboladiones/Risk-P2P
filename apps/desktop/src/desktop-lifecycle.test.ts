import { describe, expect, it } from "vitest";
import {
  desktopWindowBounds,
  MAX_BACKEND_RESTART_ATTEMPTS,
  shouldAttemptBackendRestart,
  shouldHideWindowOnClose,
} from "./desktop-lifecycle.js";

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

  it("cabe em um monitor vertical de 800 por 1280 sem forçar 900 pixels", () => {
    expect(desktopWindowBounds({ width: 800, height: 1280 })).toEqual({
      width: 800,
      height: 800,
      minWidth: 720,
      minHeight: 560,
    });
  });

  it("não cria mínimos maiores do que a área disponível", () => {
    expect(desktopWindowBounds({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
      minWidth: 640,
      minHeight: 480,
    });
  });
});

describe("recuperação do backend desktop", () => {
  it("permite novas tentativas até o limite de falhas consecutivas", () => {
    for (let attempts = 0; attempts < MAX_BACKEND_RESTART_ATTEMPTS; attempts += 1) {
      expect(shouldAttemptBackendRestart({ isQuitting: false, restarting: false, attempts })).toBe(true);
    }
    expect(shouldAttemptBackendRestart({
      isQuitting: false,
      restarting: false,
      attempts: MAX_BACKEND_RESTART_ATTEMPTS,
    })).toBe(false);
  });

  it("não inicia outra recuperação em paralelo ou durante o encerramento", () => {
    expect(shouldAttemptBackendRestart({ isQuitting: false, restarting: true, attempts: 0 })).toBe(false);
    expect(shouldAttemptBackendRestart({ isQuitting: true, restarting: false, attempts: 0 })).toBe(false);
  });
});
