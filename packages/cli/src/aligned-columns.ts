import { displayWidth } from './tui/screen/wrap.ts';

const COLUMN_GAP = '  ';

export type RowOf<Header extends readonly string[]> = { readonly [Column in keyof Header]: string };

export const alignedColumns = <const Header extends readonly string[]>(header: Header, rows: readonly RowOf<Header>[]): string[] => {
  const table: readonly (readonly string[])[] = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...table.map((cells) => displayWidth(cells[column] as string))));
  return table.map((cells) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : `${cell}${' '.repeat((widths[column] as number) - displayWidth(cell))}`))
      .join(COLUMN_GAP)
      .trimEnd(),
  );
};
