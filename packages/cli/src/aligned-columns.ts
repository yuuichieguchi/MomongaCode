import { displayWidth } from './tui/screen/wrap.ts';

const COLUMN_GAP = '  ';

export type RowOf<Header extends readonly string[]> = { readonly [Column in keyof Header]: string };

export const alignedRows = (rows: readonly (readonly string[])[]): string[] => {
  const [first] = rows;
  if (first === undefined) return [];
  const uneven = rows.find((cells) => cells.length !== first.length);
  if (uneven !== undefined) throw new Error(`every row has ${first.length} cells; one has ${uneven.length}`);
  const widths = first.map((_, column) => Math.max(...rows.map((cells) => displayWidth(cells[column] as string))));
  return rows.map((cells) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : `${cell}${' '.repeat((widths[column] as number) - displayWidth(cell))}`))
      .join(COLUMN_GAP)
      .trimEnd(),
  );
};

export const alignedColumns = <const Header extends readonly string[]>(header: Header, rows: readonly RowOf<Header>[]): string[] => alignedRows([header, ...rows]);
