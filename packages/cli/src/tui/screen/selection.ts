import { DOUBLE_CLICK_MS } from './constants.ts';
import type { ViewSource } from './viewport.ts';
import { segmentsOf } from './wrap.ts';
import type { Row } from './wrap.ts';

export type Point = { entryId: number; rowIndex: number; col: number };

export type Selection = { anchor: Point; head: Point };

export type Extract = { text: string; bytes: number; complete: boolean };

const precedes = (a: Point, b: Point): boolean => {
  if (a.entryId !== b.entryId) return a.entryId < b.entryId;
  return a.rowIndex !== b.rowIndex ? a.rowIndex < b.rowIndex : a.col <= b.col;
};

export const ordered = ({ anchor, head }: Selection): [Point, Point] => (precedes(anchor, head) ? [anchor, head] : [head, anchor]);

export const samePoint = (a: Point, b: Point): boolean => a.entryId === b.entryId && a.rowIndex === b.rowIndex && a.col === b.col;

export const selectedColumns = (selection: Selection, entryId: number, rowIndex: number): [number, number] | undefined => {
  const [start, end] = ordered(selection);
  const here: Point = { entryId, rowIndex, col: 0 };
  if (!precedes({ ...start, col: 0 }, here) || !precedes(here, { ...end, col: 0 })) return undefined;
  const first = start.entryId === entryId && start.rowIndex === rowIndex;
  const last = end.entryId === entryId && end.rowIndex === rowIndex;
  return [first ? start.col : 0, last ? end.col : Number.POSITIVE_INFINITY];
};

export const indexRangeOf = (row: Row, from: number, to: number): [number, number] | undefined => {
  const first = Math.max(from, row.prefixCols);
  let cells = 0;
  let start: number | undefined;
  let end = 0;
  for (const { segment, index, width } of segmentsOf(row.text)) {
    const lastCell = cells + Math.max(width, 1) - 1;
    if (lastCell >= first && cells <= to) {
      start ??= index;
      end = index + segment.length;
    }
    cells += width;
  }
  return start === undefined ? undefined : [start, end];
};

const pieceOf = (row: Row, from: number, to: number, endsLine: boolean): string => {
  const range = indexRangeOf(row, from, to);
  if (range === undefined) return '';
  const piece = row.text.slice(range[0], range[1]);
  return endsLine && range[1] === row.text.length ? piece.replace(/ +$/, '') : piece;
};

export const extractSelection = (source: ViewSource, selection: Selection, capBytes: number): Extract => {
  const [start, end] = ordered(selection);
  const firstIndex = source.indexOfId(start.entryId);
  const lastIndex = source.indexOfId(end.entryId);
  if (firstIndex === undefined || lastIndex === undefined) return { text: '', bytes: 0, complete: true };
  const pieces: string[] = [];
  let bytes = 0;
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const entry = source.at(index);
    const rows = source.rowsOf(entry);
    const firstRow = index === firstIndex ? start.rowIndex : 0;
    const lastRow = index === lastIndex ? Math.min(end.rowIndex, rows.length - 1) : rows.length - 1;
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row === undefined || row.kind === 'label') continue;
      const columns = selectedColumns(selection, entry.id, rowIndex) ?? [0, Number.POSITIVE_INFINITY];
      const separator = pieces.length === 0 || (row.wrapped && rowIndex > firstRow) ? '' : '\n';
      const piece = `${separator}${pieceOf(row, columns[0], columns[1], rows[rowIndex + 1]?.wrapped !== true)}`;
      bytes += Buffer.byteLength(piece, 'utf8');
      if (bytes > capBytes) return { text: pieces.join(''), bytes, complete: false };
      pieces.push(piece);
    }
  }
  return { text: pieces.join(''), bytes, complete: true };
};

const words = new Intl.Segmenter(undefined, { granularity: 'word' });

const columnAt = (text: string, index: number): number => segmentsOf(text.slice(0, index)).reduce((total, segment) => total + segment.width, 0);

const rowAt = (source: ViewSource, point: Point): { rows: readonly Row[]; row: Row } | undefined => {
  const index = source.indexOfId(point.entryId);
  if (index === undefined) return undefined;
  const rows = source.rowsOf(source.at(index));
  const row = rows[point.rowIndex];
  return row === undefined ? undefined : { rows, row };
};

export const wordSelection = (source: ViewSource, point: Point): Selection => {
  const found = rowAt(source, point);
  const range = found === undefined ? undefined : indexRangeOf(found.row, point.col, point.col);
  if (found === undefined || range === undefined) return { anchor: point, head: point };
  for (const { segment, index } of words.segment(found.row.text)) {
    if (range[0] < index || range[0] >= index + segment.length) continue;
    return { anchor: { ...point, col: columnAt(found.row.text, index) }, head: { ...point, col: columnAt(found.row.text, index + segment.length) - 1 } };
  }
  return { anchor: point, head: point };
};

export const lineSelection = (source: ViewSource, point: Point): Selection => {
  const found = rowAt(source, point);
  if (found === undefined) return { anchor: point, head: point };
  let first = point.rowIndex;
  while (first > 0 && found.rows[first]?.wrapped === true) first -= 1;
  let last = point.rowIndex;
  while (found.rows[last + 1]?.wrapped === true) last += 1;
  return { anchor: { entryId: point.entryId, rowIndex: first, col: 0 }, head: { entryId: point.entryId, rowIndex: last, col: Number.POSITIVE_INFINITY } };
};

export type ClickCount = 1 | 2 | 3;

export const createClickCounter = (now: () => number): ((point: Point) => ClickCount) => {
  let last: { point: Point; at: number; count: ClickCount } | undefined;
  return (point) => {
    const at = now();
    const repeated = last !== undefined && samePoint(last.point, point) && at - last.at <= DOUBLE_CLICK_MS && last.count < 3;
    const count: ClickCount = repeated && last !== undefined ? (last.count === 1 ? 2 : 3) : 1;
    last = { point, at, count };
    return count;
  };
};
