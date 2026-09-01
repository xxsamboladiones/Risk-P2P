import { describe, expect, it } from "vitest";
import { responsiveCallGrid } from "./call-layout";

describe("responsiveCallGrid", () => {
  it("empilha até quatro tiles em retrato sem criar altura fora da tela", () => {
    expect(responsiveCallGrid(3).portrait).toEqual({ columns: 1, rows: 3 });
    expect(responsiveCallGrid(4).portrait).toEqual({ columns: 1, rows: 4 });
  });

  it("divide grupos maiores em duas colunas no retrato", () => {
    expect(responsiveCallGrid(5).portrait).toEqual({ columns: 2, rows: 3 });
    expect(responsiveCallGrid(7).portrait).toEqual({ columns: 2, rows: 4 });
  });

  it("usa linhas compactas em monitores baixos no modo paisagem", () => {
    expect(responsiveCallGrid(3).compactLandscape).toEqual({ columns: 3, rows: 1 });
    expect(responsiveCallGrid(4).compactLandscape).toEqual({ columns: 2, rows: 2 });
    expect(responsiveCallGrid(7).compactLandscape).toEqual({ columns: 4, rows: 2 });
  });
});
