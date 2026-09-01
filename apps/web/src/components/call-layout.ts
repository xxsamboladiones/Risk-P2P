export type CallGridDimensions = {
  columns: number;
  rows: number;
};

export type ResponsiveCallGrid = {
  portrait: CallGridDimensions;
  compactLandscape: CallGridDimensions;
};

/**
 * Mantém todos os tiles dentro da área útil da chamada. Em retrato, até quatro
 * participantes aproveitam melhor a largura em uma única coluna; acima disso,
 * duas colunas evitam tiles excessivamente baixos. Monitores baixos usam mais
 * colunas para preservar espaço vertical.
 */
export function responsiveCallGrid(tileCount: number): ResponsiveCallGrid {
  const count = Math.max(1, Math.floor(tileCount));
  const portraitColumns = count <= 4 ? 1 : 2;
  const compactLandscapeColumns = count <= 3
    ? count
    : count === 4
      ? 2
      : count <= 6
        ? 3
        : 4;
  return {
    portrait: {
      columns: portraitColumns,
      rows: Math.ceil(count / portraitColumns),
    },
    compactLandscape: {
      columns: compactLandscapeColumns,
      rows: Math.ceil(count / compactLandscapeColumns),
    },
  };
}
