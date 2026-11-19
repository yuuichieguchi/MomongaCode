import { ART_WIDTH, FIGURE } from '../../packages/cli/src/tui/figure.ts';
import type { ArtPart } from '../../packages/cli/src/tui/figure.ts';
import { escapeHtml, tokenClass } from './text.ts';

const CELL_WIDTH = 12;
const ROW_HEIGHT = 24;
const FONT_SIZE = 20;

type Pose = 'rest' | 'swing';

type ColumnRange = { first: number; last: number };

const FULL_WIDTH: ColumnRange = { first: 0, last: ART_WIDTH - 1 };

const cellsOf = (row: number, parts: readonly ArtPart[], pose: Pose | undefined, columns: ColumnRange = FULL_WIDTH): string[] => {
  const cells: string[] = [];
  let column = 0;
  for (const part of parts) {
    for (const glyph of part.text) {
      if (glyph !== ' ' && column >= columns.first && column <= columns.last) {
        if (part.token === undefined) throw new Error(`the figure has the glyph ${glyph} at row ${row}, column ${column} with no colour`);
        const shown = column - columns.first;
        const x = (shown + 0.5) * CELL_WIDTH;
        const y = (row + 0.5) * ROW_HEIGHT;
        cells.push(`<text x="${x}" y="${y}" class="${tokenClass(part.token)}" data-row="${row}" data-col="${shown}" data-token="${part.token}"${pose === undefined ? '' : ` data-pose="${pose}"`}>${escapeHtml(glyph)}</text>`);
      }
      column += 1;
    }
  }
  return cells;
};

const figureCells = (rows: number): string[] =>
  FIGURE.slice(0, rows).flatMap((row, index) => (row.swing === undefined ? cellsOf(index, row.rest, undefined) : [...cellsOf(index, row.rest, 'rest'), ...cellsOf(index, row.swing, 'swing')]));

const viewBox = (rows: number): string => `0 0 ${ART_WIDTH * CELL_WIDTH} ${rows * ROW_HEIGHT}`;

export const FIGURE_TEXT_STYLE = `font-size:${FONT_SIZE}px;text-anchor:middle;dominant-baseline:central`;

export const landingFigure = (): string => `<svg class="figure" viewBox="${viewBox(FIGURE.length)}" aria-hidden="true" focusable="false">${figureCells(FIGURE.length).join('')}</svg>`;

const ICON_ROWS = 2;

const HEAD_ROW = 1;

const headColumns = (): ColumnRange => {
  const columns: number[] = [];
  let column = 0;
  for (const part of (FIGURE[HEAD_ROW] as (typeof FIGURE)[number]).rest) {
    for (const glyph of part.text) {
      if (glyph !== ' ' && part.token !== undefined && part.token !== 'banner.membrane') columns.push(column);
      column += 1;
    }
  }
  if (columns.length === 0) throw new Error(`the figure has no head in row ${HEAD_ROW}`);
  return { first: Math.min(...columns), last: Math.max(...columns) };
};

const HEAD = headColumns();

const iconCells = (): string[] => FIGURE.slice(0, ICON_ROWS).flatMap((row, index) => cellsOf(index, row.rest, undefined, HEAD));

const iconViewBox = (): string => {
  const width = (HEAD.last - HEAD.first + 1) * CELL_WIDTH;
  const height = ICON_ROWS * ROW_HEIGHT;
  const side = Math.max(width, height);
  return `${(width - side) / 2} ${(height - side) / 2} ${side} ${side}`;
};

export const ICON_TOKENS: ReadonlySet<string> = new Set(iconCells().map((cell) => /data-token="([^"]*)"/.exec(cell)?.[1] as string));

export const iconFigure = (style: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${iconViewBox()}"><style>${style}</style>${iconCells().join('')}</svg>\n`;
