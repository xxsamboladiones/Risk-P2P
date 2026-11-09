export type ScreenSourceKind = "screen" | "window";

type SelectableScreenSource = {
  id: string;
  kind?: ScreenSourceKind;
};

export function screenSourceKind(source: SelectableScreenSource): ScreenSourceKind {
  if (source.kind) return source.kind;
  return source.id.startsWith("screen:") ? "screen" : "window";
}

export function filterScreenSources<T extends SelectableScreenSource>(sources: T[], fullscreenGames: boolean): T[] {
  if (!fullscreenGames) return sources;
  return sources.filter((source) => screenSourceKind(source) === "screen");
}
