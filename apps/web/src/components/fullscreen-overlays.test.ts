import { afterEach, describe, expect, it, vi } from "vitest";
import { observeFullscreenOverlays } from "./fullscreen-overlays";

function fixture(native = true) {
  vi.useFakeTimers();
  const attributes = new Map<string, string>(native ? [["data-risk-native-fullscreen", "true"]] : []);
  const element = Object.assign(new EventTarget(), {
    getAttribute: (key: string) => attributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  });
  const document = Object.assign(new EventTarget(), { fullscreenElement: native ? null : element, pointerLockElement: null as EventTarget | null });
  let mutation: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("document", document);
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {} disconnect = disconnect;
  });
  const close = observeFullscreenOverlays(element as unknown as HTMLElement);
  return { element, document, attributes, mutation, close, disconnect, visible: () => attributes.get("data-risk-overlays-visible") };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("controles em tela cheia", () => {
  it.each([true, false])("oculta depois de inatividade e revela por movimento (fullscreen nativo: %s)", (native) => {
    const t = fixture(native);
    expect(t.visible()).toBe("true");
    vi.advanceTimersByTime(3000); expect(t.visible()).toBe("false");
    t.element.dispatchEvent(new Event("pointermove")); expect(t.visible()).toBe("true");
    vi.advanceTimersByTime(2500); t.element.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(1000); expect(t.visible()).toBe("true");
    vi.advanceTimersByTime(2000); expect(t.visible()).toBe("false"); t.close();
  });
  it("movimentos do jogo não revelam overlays; Esc revela e mantém temporariamente", () => {
    const t = fixture(); t.document.pointerLockElement = t.element;
    vi.advanceTimersByTime(3000); t.element.dispatchEvent(new Event("pointermove"));
    expect(t.visible()).toBe("false");
    t.element.dispatchEvent(new Event("risk-show-overlays")); expect(t.visible()).toBe("true");
    vi.advanceTimersByTime(3000); expect(t.visible()).toBe("false"); t.close();
  });
  it("restaura controles ao sair de fullscreen e cancela temporizador na desmontagem", () => {
    const t = fixture(); vi.advanceTimersByTime(3000);
    t.attributes.delete("data-risk-native-fullscreen"); t.mutation();
    expect(t.visible()).toBeUndefined();
    t.attributes.set("data-risk-native-fullscreen", "true"); t.mutation();
    expect(t.visible()).toBe("true"); t.close();
    vi.advanceTimersByTime(3000); expect(t.visible()).toBeUndefined();
    expect(t.disconnect).toHaveBeenCalledOnce();
  });
});
