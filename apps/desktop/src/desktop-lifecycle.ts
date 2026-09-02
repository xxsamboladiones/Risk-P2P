export type CloseWindowContext = {
  isQuitting: boolean;
  trayAvailable: boolean;
  automatedRun: boolean;
};

export type DesktopWorkArea = { width: number; height: number };
export type DesktopWindowBounds = DesktopWorkArea & { minWidth: number; minHeight: number };

export const MAX_BACKEND_RESTART_ATTEMPTS = 3;

export function shouldHideWindowOnClose(context: CloseWindowContext): boolean {
  return context.trayAvailable && !context.isQuitting && !context.automatedRun;
}

export function desktopWindowBounds(workArea: DesktopWorkArea): DesktopWindowBounds {
  const availableWidth = Math.max(320, Math.floor(workArea.width));
  const availableHeight = Math.max(360, Math.floor(workArea.height));
  return {
    width: Math.min(1280, availableWidth),
    height: Math.min(800, availableHeight),
    minWidth: Math.min(720, availableWidth),
    minHeight: Math.min(560, availableHeight),
  };
}

export function shouldAttemptBackendRestart(context: {
  isQuitting: boolean;
  restarting: boolean;
  attempts: number;
  maxAttempts?: number;
}): boolean {
  const maxAttempts = context.maxAttempts ?? MAX_BACKEND_RESTART_ATTEMPTS;
  return !context.isQuitting && !context.restarting && context.attempts < maxAttempts;
}
