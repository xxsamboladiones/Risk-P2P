import { afterEach, describe, expect, it, vi } from "vitest";
import { captureGameInput } from "./capture";
import type { GameInputFrame } from "@risk/protocol";

function fixture(device: "keyboard-mouse" | "gamepad" = "keyboard-mouse", toggle = vi.fn(), preserveLock = () => false) {
  const element = Object.assign(new EventTarget(), { setAttribute: vi.fn(), removeAttribute: vi.fn() });
  const document = Object.assign(new EventTarget(), { pointerLockElement: element, visibilityState: "visible", exitPointerLock: vi.fn() });
  const window = new EventTarget(); let time = 0; let frame: FrameRequestCallback | undefined;
  const pad = { connected: true, index: 0, mapping: "standard", axes: [0.4, -0.5, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ value: i === 0 ? 1 : 0 })) };
  vi.stubGlobal("document", document); vi.stubGlobal("window", window); vi.stubGlobal("navigator", { getGamepads: () => [pad] });
  vi.stubGlobal("performance", { now: () => time });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; }); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const sent: GameInputFrame[] = []; const leave = vi.fn(); const overlays = vi.fn();
  const send = vi.fn((snapshot: GameInputFrame) => { sent.push(snapshot); return true; });
  const close = captureGameInput(element as unknown as HTMLElement, { sessionId: "s", grantId: "g", device }, send, leave, overlays, toggle, preserveLock);
  const emit = (type: string, data: Record<string, unknown>) => window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), data));
  return { document, window, element, pad, sent, send, leave, overlays, close, emit, tick(ms = 17) { time += ms; frame?.(time); } };
}
afterEach(() => vi.unstubAllGlobals());
describe("captura de input do jogador", () => {
  it.each(["keyboard-mouse", "gamepad"] as const)("consome F8 uma vez por pressão em %s", (device) => {
    const toggle = vi.fn(); const t = fixture(device, toggle);
    expect(t.emit("keydown", { code: "F8", repeat: false })).toBe(false);
    t.emit("keydown", { code: "F8", repeat: true });
    t.emit("keydown", { code: "F8", repeat: false });
    expect(toggle).toHaveBeenCalledOnce();
    t.emit("keyup", { code: "F8" }); t.emit("keydown", { code: "F8", repeat: false });
    expect(toggle).toHaveBeenCalledTimes(2); t.tick();
    expect(t.sent.every((frame) => !frame.keys.includes("F8"))).toBe(true); t.close();
  });
  it("preserva o pointer lock adquirido para a próxima concessão", () => {
    const t = fixture("gamepad", vi.fn(), () => true);
    t.close(); expect(t.document.exitPointerLock).not.toHaveBeenCalled();
  });
  it("retoma após congestionamento curto sem exigir Jogar Junto novamente", () => {
    const t = fixture("gamepad");
    t.send.mockReturnValue(false); t.tick(1500);
    expect(t.leave).not.toHaveBeenCalled();
    t.send.mockImplementation((frame) => { t.sent.push(frame); return true; }); t.tick();
    expect(t.sent.at(-1)?.sequence).toBe(1);
    t.send.mockReturnValue(false); t.tick(10001);
    expect(t.leave).toHaveBeenCalledOnce(); t.close();
  });
  it("envia code imediatamente e repete o snapshot de keyup, com movimento acumulado por frame", () => {
    const t = fixture();
    t.emit("keydown", { code: "KeyW", repeat: false });
    expect(t.sent[0]?.keys).toEqual(["KeyW"]);
    t.emit("mousemove", { movementX: 3, movementY: -2 }); t.emit("mousemove", { movementX: 4, movementY: 1 });
    expect(t.sent).toHaveLength(1); t.tick();
    expect(t.sent.at(-1)).toMatchObject({ keys: ["KeyW"], x: 7, y: -1 });
    t.emit("keyup", { code: "KeyW", repeat: false }); t.tick();
    expect(t.sent.slice(-2).map((f) => f.keys)).toEqual([[], []]);
    expect(t.sent.map((f) => f.sequence)).toEqual([0, 1, 2, 3]);
    t.close(); t.emit("keydown", { code: "KeyW" }); expect(t.sent).toHaveLength(4);
    expect(t.document.exitPointerLock).toHaveBeenCalledOnce();
  });
  it.each(["blur", "visibilitychange"])("sai e libera a captura ao receber %s", (reason) => {
    const t = fixture();
    if (reason === "blur") t.emit(reason, {});
    else {
      t.document.visibilityState = "hidden";
      t.document.dispatchEvent(new Event(reason));
    }
    expect(t.leave).toHaveBeenCalledOnce(); t.tick(); expect(t.sent).toHaveLength(0); t.close();
  });
  it("primeiro Esc revela controles e neutraliza teclado; só outra pressão sai", () => {
    const t = fixture();
    t.emit("keydown", { code: "KeyW" }); t.emit("mousedown", { buttons: 1 });
    t.emit("keydown", { code: "Escape", repeat: false });
    expect(t.leave).not.toHaveBeenCalled();
    expect(t.overlays).toHaveBeenLastCalledWith(true);
    expect(t.sent.at(-1)).toMatchObject({ keys: [], buttons: 0 });
    t.emit("keydown", { code: "KeyA" }); t.tick();
    expect(t.sent.at(-1)?.keys).toEqual([]);
    t.emit("keydown", { code: "Escape", repeat: true });
    t.emit("keyup", { code: "Escape" });
    expect(t.leave).not.toHaveBeenCalled();
    t.tick(500); t.emit("keydown", { code: "Escape" });
    expect(t.leave).toHaveBeenCalledOnce(); t.close();
  });
  it("reinicia a confirmação de saída depois de dois segundos", () => {
    const t = fixture("gamepad");
    t.emit("keydown", { code: "Escape" }); t.emit("keyup", { code: "Escape" });
    t.tick(2100); t.emit("keydown", { code: "Escape" });
    expect(t.leave).not.toHaveBeenCalled();
    expect(t.sent.at(-1)?.gamepad?.axes).toEqual([0.4, -0.5, 0, 0]);
    t.emit("keyup", { code: "Escape" }); t.emit("keydown", { code: "Escape" });
    expect(t.leave).toHaveBeenCalledOnce(); t.close();
  });
  it.each([true, false])("perda nativa do mouse conta apenas um Esc (keydown entregue: %s)", (keydown) => {
    const t = fixture(); t.emit("keydown", { code: "KeyW" });
    Object.assign(t.document, { pointerLockElement: null });
    t.document.dispatchEvent(new Event("pointerlockchange"));
    if (keydown) t.emit("keydown", { code: "Escape" });
    t.emit("keyup", { code: "Escape" });
    expect(t.leave).not.toHaveBeenCalled();
    expect(t.sent.at(-1)?.keys).toEqual([]);
    t.tick(400); t.emit("keydown", { code: "Escape" });
    expect(t.leave).toHaveBeenCalledOnce(); t.close();
  });
  it("retoma captura no mesmo grant e sequência ao recapturar mouse", () => {
    const t = fixture(); t.emit("keydown", { code: "KeyW" });
    t.emit("keydown", { code: "Escape" }); t.emit("keyup", { code: "Escape" });
    Object.assign(t.document, { pointerLockElement: null }); t.document.dispatchEvent(new Event("pointerlockchange"));
    t.tick();
    Object.assign(t.document, { pointerLockElement: t.element }); t.document.dispatchEvent(new Event("pointerlockchange"));
    t.emit("keydown", { code: "KeyA" });
    expect(t.sent.at(-1)).toMatchObject({ keys: ["KeyA"], grantId: "g", sequence: 3 });
    expect(t.overlays).toHaveBeenLastCalledWith(false);
    expect(t.leave).not.toHaveBeenCalled(); t.close();
  });
  it("transmite estado completo do controle sem permitir teclado/mouse nessa concessão", () => {
    const t = fixture("gamepad"); t.emit("keydown", { code: "KeyW" }); t.tick();
    expect(t.sent[0]).toMatchObject({ keys: [], buttons: 0, x: 0, gamepad: { axes: [0.4, -0.5, 0, 0], buttons: [1, ...Array(16).fill(0)] } });
    t.pad.connected = false; t.tick(); expect(t.leave).toHaveBeenCalledOnce(); t.close();
  });
});
