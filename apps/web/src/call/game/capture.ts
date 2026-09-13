import { GAME_KEYS, type GameInputFrame, type GameDevice } from "@risk/protocol";

export function captureGameInput(element: HTMLElement, grant: { sessionId: string; grantId: string; device: GameDevice }, send: (frame: GameInputFrame) => boolean, leave: () => void, showOverlays: (keyboardPaused: boolean) => void = () => {}, switchDevice: () => void = () => {}, preserveLock: () => boolean = () => false): () => void {
  element.setAttribute("data-risk-game-playing", "true");
  const keys = new Set<string>();
  let buttons = 0, x = 0, y = 0, wheel = 0, sequence = 0, stopped = false, animation = 0;
  let lastSent = 0, lastSuccess = performance.now(), gamepadIndex: number | undefined;
  let keyboardPaused = false, escapeHeld = false, switchHeld = false, nativeEscapePending = false;
  let lastEscape: number | undefined;
  const ownsKeyboard = () => !keyboardPaused && grant.device === "keyboard-mouse" && document.pointerLockElement === element;
  const stop = () => { if (!stopped) { stopped = true; leave(); } };
  const snapshot = () => {
    if (stopped) return;
    const frame: GameInputFrame = { version: 1, sessionId: grant.sessionId, grantId: grant.grantId, sequence: sequence++, keys: [...keys], buttons, x, y, wheel };
    if (grant.device === "gamepad") {
      const pads = [...(navigator.getGamepads?.() ?? [])];
      const pad = gamepadIndex === undefined ? pads.find((p) => p?.connected && p.mapping === "standard") : pads[gamepadIndex];
      if (gamepadIndex !== undefined && !pad?.connected) { stop(); return; }
      if (pad) gamepadIndex = pad.index;
      frame.gamepad = {
        axes: Array.from({ length: 4 }, (_, i) => Math.max(-1, Math.min(1, pad?.axes[i] ?? 0))),
        buttons: Array.from({ length: 17 }, (_, i) => Math.max(0, Math.min(1, pad?.buttons[i]?.value ?? 0))),
      };
    }
    if (send(frame)) lastSuccess = performance.now();
    else if (performance.now() - lastSuccess > 10000) stop();
  };
  const reveal = () => {
    if (grant.device === "keyboard-mouse" && !keyboardPaused) {
      keyboardPaused = true;
      keys.clear(); buttons = 0;
      snapshot();
      if (document.pointerLockElement === element) document.exitPointerLock();
    }
    showOverlays(keyboardPaused);
  };
  const keyboard = (event: KeyboardEvent) => {
    if (stopped) return;
    if (event.code === "F8") {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === "keyup") switchHeld = false;
      else if (!event.repeat && !switchHeld) { switchHeld = true; switchDevice(); }
      return;
    }
    if (event.code === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === "keyup") { escapeHeld = false; nativeEscapePending = false; return; }
      if (event.repeat || escapeHeld) return;
      escapeHeld = true;
      const now = performance.now();
      // Chromium may emit pointerlockchange before delivering the same Escape.
      if (nativeEscapePending && lastEscape !== undefined && now - lastEscape < 150) { nativeEscapePending = false; return; }
      nativeEscapePending = false;
      if (lastEscape !== undefined && now - lastEscape <= 2000) { stop(); return; }
      lastEscape = now;
      reveal();
      return;
    }
    if (!ownsKeyboard() || !GAME_KEYS.has(event.code)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.repeat) return;
    if (event.type === "keydown") keys.add(event.code); else keys.delete(event.code);
    snapshot();
  };
  const mouse = (event: MouseEvent) => {
    if (!ownsKeyboard()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === "mousemove") { x += Math.round(event.movementX); y += Math.round(event.movementY); }
    else { buttons = event.buttons & 31; snapshot(); }
  };
  const scroll = (event: WheelEvent) => {
    if (!ownsKeyboard()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    wheel += Math.sign(event.deltaY) * 120;
  };
  const lock = () => {
    if (stopped || grant.device !== "keyboard-mouse") return;
    if (document.pointerLockElement === element) {
      keyboardPaused = false; lastEscape = undefined; nativeEscapePending = false;
      showOverlays(false);
    } else if (!keyboardPaused) {
      // Native Escape can release pointer lock without a DOM keydown at all.
      lastEscape = performance.now(); nativeEscapePending = true;
      reveal();
    }
  };
  const hidden = () => { if (document.visibilityState !== "visible") stop(); };
  const context = (event: Event) => { if (ownsKeyboard()) event.preventDefault(); };
  const tick = (time: number) => {
    if (stopped) return;
    if (time - lastSent >= 16) { snapshot(); lastSent = time; }
    animation = requestAnimationFrame(tick);
  };
  window.addEventListener("keydown", keyboard, true); window.addEventListener("keyup", keyboard, true);
  window.addEventListener("mousemove", mouse, true); window.addEventListener("mousedown", mouse, true); window.addEventListener("mouseup", mouse, true);
  window.addEventListener("wheel", scroll, { capture: true, passive: false });
  window.addEventListener("blur", stop); element.addEventListener("contextmenu", context);
  document.addEventListener("pointerlockchange", lock); document.addEventListener("visibilitychange", hidden);
  animation = requestAnimationFrame(tick);
  return () => {
    stopped = true; cancelAnimationFrame(animation);
    element.removeAttribute("data-risk-game-playing");
    window.removeEventListener("keydown", keyboard, true); window.removeEventListener("keyup", keyboard, true);
    window.removeEventListener("mousemove", mouse, true); window.removeEventListener("mousedown", mouse, true); window.removeEventListener("mouseup", mouse, true);
    window.removeEventListener("wheel", scroll, true); window.removeEventListener("blur", stop); element.removeEventListener("contextmenu", context);
    document.removeEventListener("pointerlockchange", lock); document.removeEventListener("visibilitychange", hidden);
    if (document.pointerLockElement === element && !preserveLock()) document.exitPointerLock();
  };
}
