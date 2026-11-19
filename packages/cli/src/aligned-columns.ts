import { displayWidth } from './tui/screen/wrap.ts';

const COLUMN_GAP = '  ';

export const alignedColumns = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => {
  const table = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...table.map((cells) => displayWidth(cells[column] ?? ''))));
  return table.map((cells) => {
    const filled = header.map((_, column) => cells[column] ?? '');
    const last = filled.findLastIndex((cell) => cell !== '');
    return filled
      .slice(0, last + 1)
      .map((cell, column) => (column === last ? cell : `${cell}${' '.repeat((widths[column] ?? 0) - displayWidth(cell))}`))
      .join(COLUMN_GAP);
  });
};
