const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

export type DesktopSource = {
  id: string;
  name: string;
  displayId: string;
  thumbnail: string;
};

export type DesktopBackendConfig = {
  baseUrl: string;
  token: string;
};

const FULLSCREEN_STYLE_ID = "risk-native-stream-fullscreen-style";
const MIN_FULLSCREEN_ZOOM = 0.5;
const MAX_FULLSCREEN_ZOOM = 5;
const FULLSCREEN_ZOOM_FACTOR = 1.12;
let activeFullscreenTile: HTMLElement | null = null;
let activeFullscreenWorkspace: HTMLElement | null = null;
let activeFullscreenZoom = 1;

function installNativeStreamFullscreenStyle(): void {
  if (document.getElementById(FULLSCREEN_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FULLSCREEN_STYLE_ID;
  style.textContent = `
html.risk-native-stream-fullscreen,
body.risk-native-stream-fullscreen {
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  overflow: hidden !important;
  background: #000 !important;
}
html.risk-native-stream-fullscreen #root {
  width: 100vw !important;
  height: 100vh !important;
  overflow: hidden !important;
  background: #000 !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483000 !important;
  width: 100vw !important;
  height: 100vh !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background: #000 !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] > header,
.call-workspace[data-risk-native-fullscreen-active="true"] > footer,
.call-workspace[data-risk-native-fullscreen-active="true"] > .call-chat-view,
.call-workspace[data-risk-native-fullscreen-active="true"] > .global-error {
  display: none !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] > .call-view {
  display: block !important;
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  min-width: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  background: #000 !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] > .call-view > .stage {
  display: block !important;
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background: #000 !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] .stage > * {
  display: none !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] .stage > [data-risk-native-fullscreen="true"] {
  display: block !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483001 !important;
  width: 100vw !important;
  height: 100vh !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: none !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  overflow: hidden !important;
  background: #000 !important;
  grid-column: auto !important;
  grid-row: auto !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] [data-risk-native-fullscreen="true"] video {
  width: 100vw !important;
  height: 100vh !important;
  min-width: 100vw !important;
  min-height: 100vh !important;
  max-width: none !important;
  max-height: none !important;
  object-fit: contain !important;
  background: #000 !important;
  transform: scale(var(--risk-fullscreen-zoom, 1)) !important;
  transform-origin: var(--risk-fullscreen-origin-x, 50%) var(--risk-fullscreen-origin-y, 50%) !important;
  transition: transform 70ms ease-out !important;
  will-change: transform;
}
.call-workspace[data-risk-native-fullscreen-active="true"] [data-risk-native-fullscreen="true"] .tile-label,
.call-workspace[data-risk-native-fullscreen-active="true"] [data-risk-native-fullscreen="true"] .source-switch,
.call-workspace[data-risk-native-fullscreen-active="true"] [data-risk-native-fullscreen="true"] .volume-panel {
  display: none !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] [data-risk-native-fullscreen="true"] .tile-fullscreen {
  position: fixed !important;
  top: 16px !important;
  right: 16px !important;
  bottom: auto !important;
  left: auto !important;
  z-index: 2147483002 !important;
  opacity: 0 !important;
  transition: opacity .15s ease !important;
}
.call-workspace[data-risk-native-fullscreen-active="true"] [data-risk-native-fullscreen="true"]:hover .tile-fullscreen {
  opacity: .9 !important;
}
`;
  document.head.appendChild(style);
}

function clearFullscreenZoomStyles(tile: HTMLElement | null): void {
  activeFullscreenZoom = 1;
  if (!tile) return;
  tile.style.removeProperty("--risk-fullscreen-zoom");
  tile.style.removeProperty("--risk-fullscreen-origin-x");
  tile.style.removeProperty("--risk-fullscreen-origin-y");
}

function setFullscreenZoom(tile: HTMLElement, zoom: number, originX: number, originY: number): void {
  activeFullscreenZoom = zoom;
  tile.style.setProperty("--risk-fullscreen-zoom", zoom.toFixed(3));
  tile.style.setProperty("--risk-fullscreen-origin-x", `${originX.toFixed(2)}%`);
  tile.style.setProperty("--risk-fullscreen-origin-y", `${originY.toFixed(2)}%`);
}

function adjustFullscreenZoom(event: WheelEvent): void {
  const tile = activeFullscreenTile;
  if (!tile || event.deltaY === 0) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const factor = event.deltaY < 0 ? FULLSCREEN_ZOOM_FACTOR : 1 / FULLSCREEN_ZOOM_FACTOR;
  const nextZoom = Math.min(MAX_FULLSCREEN_ZOOM, Math.max(MIN_FULLSCREEN_ZOOM, activeFullscreenZoom * factor));
  if (Math.abs(nextZoom - activeFullscreenZoom) < 0.001) return;

  const rect = tile.getBoundingClientRect();
  const relativeX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
  const relativeY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  const originX = Math.min(1, Math.max(0, relativeX)) * 100;
  const originY = Math.min(1, Math.max(0, relativeY)) * 100;

  setFullscreenZoom(tile, nextZoom, originX, originY);
}

function cleanupFullscreenDom(): void {
  clearFullscreenZoomStyles(activeFullscreenTile);
  activeFullscreenTile?.removeAttribute("data-risk-native-fullscreen");
  activeFullscreenWorkspace?.removeAttribute("data-risk-native-fullscreen-active");
  document.documentElement.classList.remove("risk-native-stream-fullscreen");
  document.body.classList.remove("risk-native-stream-fullscreen");
  activeFullscreenTile = null;
  activeFullscreenWorkspace = null;
}

async function exitNativeStreamFullscreen(): Promise<void> {
  cleanupFullscreenDom();
  await ipcRenderer.invoke("window:fullscreen", false).catch(() => undefined);
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
}

async function enterNativeStreamFullscreen(tile: HTMLElement): Promise<void> {
  if (activeFullscreenTile === tile) {
    await exitNativeStreamFullscreen();
    return;
  }
  if (activeFullscreenTile) await exitNativeStreamFullscreen();

  const workspace = tile.closest<HTMLElement>(".call-workspace");
  if (!workspace) return;

  activeFullscreenTile = tile;
  activeFullscreenWorkspace = workspace;
  setFullscreenZoom(tile, 1, 50, 50);
  tile.setAttribute("data-risk-native-fullscreen", "true");
  workspace.setAttribute("data-risk-native-fullscreen-active", "true");
  document.documentElement.classList.add("risk-native-stream-fullscreen");
  document.body.classList.add("risk-native-stream-fullscreen");

  try {
    await ipcRenderer.invoke("window:fullscreen", true);
  } catch (error) {
    cleanupFullscreenDom();
    try {
      await tile.requestFullscreen();
    } catch {
      console.warn("Risk não conseguiu entrar em tela cheia.", error);
    }
  }
}

function tileFromFullscreenButton(event: MouseEvent): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const button = target.closest(".tile-fullscreen");
  if (!button) return null;
  return button.closest<HTMLElement>(".tile");
}

function installNativeStreamFullscreenController(): void {
  installNativeStreamFullscreenStyle();

  document.addEventListener("click", (event) => {
    const tile = tileFromFullscreenButton(event);
    if (!tile) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void enterNativeStreamFullscreen(tile);
  }, true);

  document.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tile = target.closest<HTMLElement>(".call-workspace .tile");
    if (!tile) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void enterNativeStreamFullscreen(tile);
  }, true);

  document.addEventListener("wheel", (event) => {
    if (!activeFullscreenTile) return;
    adjustFullscreenZoom(event);
  }, { capture: true, passive: false });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !activeFullscreenTile) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void exitNativeStreamFullscreen();
  }, true);

  const observer = new MutationObserver(() => {
    if (activeFullscreenTile && !activeFullscreenTile.isConnected) {
      void exitNativeStreamFullscreen();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", installNativeStreamFullscreenController, { once: true });
} else {
  installNativeStreamFullscreenController();
}

contextBridge.exposeInMainWorld("desktop", {
  listScreenSources: (): Promise<DesktopSource[]> => ipcRenderer.invoke("screen:list"),
  chooseScreenSource: (): Promise<string | null> => ipcRenderer.invoke("screen:choose"),
  selectScreenSource: (sourceId: string): Promise<void> => ipcRenderer.invoke("screen:select", sourceId),
  setWindowFullscreen: (enabled: boolean): Promise<{ fullscreen: boolean }> => ipcRenderer.invoke("window:fullscreen", enabled),
  getBackendConfig: (): Promise<DesktopBackendConfig> => ipcRenderer.invoke("backend:config"),
});
