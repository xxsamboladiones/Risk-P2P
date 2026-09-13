/** Shares overlay timing between HTML fullscreen and the desktop's native tile. */
export function observeFullscreenOverlays(element: HTMLElement): () => void {
  let fullscreen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reveal = () => {
    if (!fullscreen) return;
    clearTimeout(timer);
    element.setAttribute("data-risk-overlays-visible", "true");
    timer = setTimeout(() => element.setAttribute("data-risk-overlays-visible", "false"), 3000);
  };
  const update = () => {
    const next = document.fullscreenElement === element || element.getAttribute("data-risk-native-fullscreen") === "true";
    if (next === fullscreen) return;
    fullscreen = next;
    if (fullscreen) reveal();
    else { clearTimeout(timer); element.removeAttribute("data-risk-overlays-visible"); }
  };
  const activity = () => { if (document.pointerLockElement !== element) reveal(); };
  const observer = new MutationObserver(update);
  observer.observe(element, { attributes: true, attributeFilter: ["data-risk-native-fullscreen"] });
  document.addEventListener("fullscreenchange", update);
  element.addEventListener("pointermove", activity);
  element.addEventListener("pointerdown", activity);
  element.addEventListener("focusin", activity);
  element.addEventListener("risk-show-overlays", reveal);
  update();
  return () => {
    clearTimeout(timer); observer.disconnect();
    element.removeAttribute("data-risk-overlays-visible");
    document.removeEventListener("fullscreenchange", update);
    element.removeEventListener("pointermove", activity);
    element.removeEventListener("pointerdown", activity);
    element.removeEventListener("focusin", activity);
    element.removeEventListener("risk-show-overlays", reveal);
  };
}
