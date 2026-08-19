import { contextBridge, ipcRenderer } from "electron";
export type DesktopSource = { id: string; name: string; displayId: string; thumbnail: string };
contextBridge.exposeInMainWorld("desktop", { listScreenSources: (): Promise<DesktopSource[]> => ipcRenderer.invoke("screen:list") });
