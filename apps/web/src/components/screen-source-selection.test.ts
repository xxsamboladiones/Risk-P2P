import { describe, expect, it } from "vitest";
import { filterScreenSources, screenSourceKind } from "./screen-source-selection";

const sources = [
  { id: "window:321:0", name: "PCSX2", displayId: "", thumbnail: "", kind: "window" as const },
  { id: "screen:0:0", name: "Tela 1", displayId: "1", thumbnail: "", kind: "screen" as const },
];

describe("seleção de fonte para jogos em tela cheia", () => {
  it("mantém apenas monitores no modo de jogos em tela cheia", () => {
    expect(filterScreenSources(sources, true).map((source) => source.id)).toEqual(["screen:0:0"]);
  });

  it("mantém telas e janelas no modo normal", () => {
    expect(filterScreenSources(sources, false)).toEqual(sources);
  });

  it("reconhece fontes antigas pelo prefixo do id", () => {
    expect(screenSourceKind({ ...sources[0]!, kind: undefined })).toBe("window");
    expect(screenSourceKind({ ...sources[1]!, kind: undefined })).toBe("screen");
  });
});
