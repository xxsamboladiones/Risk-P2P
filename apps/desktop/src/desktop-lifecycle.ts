export type CloseWindowContext = {
  isQuitting: boolean;
  trayAvailable: boolean;
  automatedRun: boolean;
};

export function shouldHideWindowOnClose(context: CloseWindowContext): boolean {
  return context.trayAvailable && !context.isQuitting && !context.automatedRun;
}
