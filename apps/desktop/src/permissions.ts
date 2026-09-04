import { session } from "electron";

const ALLOWED_PERMISSIONS = new Set(["media", "display-capture", "fullscreen"]);

export function registerPermissionPolicy(isTrustedRendererUrl: (value: string) => boolean): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrustedRendererUrl(webContents.getURL()) && ALLOWED_PERMISSIONS.has(permission));
  });
}
