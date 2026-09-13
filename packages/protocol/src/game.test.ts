import { describe, expect, it } from "vitest";
import { encodeGameControl, parseGameControl, parseGameInput } from "./game";
describe("protocolo de jogo", () => {
  const frame = { version: 1, sessionId: "s", grantId: "g", sequence: 1, keys: ["KeyW"], buttons: 0, x: 2, y: -1, wheel: 0 };
  it("valida snapshots completos e rejeita números, teclas ou dimensões inválidas", () => {
    expect(parseGameInput(JSON.stringify(frame))).toEqual(frame);
    for (const invalid of [{ sequence: -1 }, { keys: ["RunCommand"] }, { keys: ["KeyW", "KeyW"] }, { buttons: 32 }, { x: 1e10 }, { gamepad: { axes: [0], buttons: [] } }]) expect(parseGameInput(JSON.stringify({ ...frame, ...invalid }))).toBeNull();
    expect(parseGameInput("x".repeat(4097))).toBeNull();
  });
  it("isola o canal de controle da aplicação e valida a sessão", () => {
    const message = { type: "join-request", sessionId: "s", requestId: "r", device: "keyboard-mouse" } as const;
    expect(parseGameControl(encodeGameControl(message))).toMatchObject(message);
    expect(parseGameControl(JSON.stringify(message))).toBeNull();
    expect(parseGameControl(encodeGameControl({ ...message, sessionId: "../../command" }))).toBeNull();
  });
});
