import type { ActionId, KeyContext, KeyTable } from '../keys/table.ts';
import type { TerminalEvent } from '../terminal/events.ts';
import { WHEEL_ROWS } from './constants.ts';
import type { RowCache } from './row-cache.ts';
import type { StoreEntry, TranscriptStore } from './store.ts';
import type { Row } from './wrap.ts';

export type Anchor = { entryId: number; rowOffset: number };

export type Position = { anchor: Anchor | undefined; following: boolean };

export type VisibleRow = { entryId: number; rowIndex: number; row: Row };

export type ViewWindow = { rows: VisibleRow[]; firstIndex: number; lastIndex: number; atTop: boolean; atBottom: boolean };

export type ViewSource = {
  count(): number;
  at(index: number): StoreEntry;
  indexOfId(id: number): number | undefined;
  rowsOf(entry: StoreEntry): readonly Row[];
  parsed(entry: StoreEntry): boolean;
};

export type ViewportMove = { kind: 'rows'; rows: number } | { kind: 'top' } | { kind: 'bottom' };

export const FOLLOWING: Position = { anchor: undefined, following: true };

export const sourceOf = (store: Pick<TranscriptStore, 'count' | 'at' | 'indexOfId'>, cache: RowCache, width: number): ViewSource => ({
  count: store.count,
  at: store.at,
  indexOfId: store.indexOfId,
  rowsOf: (entry) => cache.rowsOf(entry, width),
  parsed: (entry) => cache.parsed(entry, width),
});

type Cursor = { index: number; row: number };

const EMPTY: ViewWindow = { rows: [], firstIndex: 0, lastIndex: 0, atTop: true, atBottom: true };

const endOf = (source: ViewSource): Cursor => ({ index: source.count(), row: 0 });

const cursorOf = (source: ViewSource, anchor: Anchor | undefined): Cursor => {
  const index = anchor === undefined ? undefined : source.indexOfId(anchor.entryId);
  if (anchor === undefined || index === undefined) return { index: 0, row: 0 };
  return { index, row: Math.max(0, Math.min(anchor.rowOffset, source.rowsOf(source.at(index)).length - 1)) };
};

const forward = (source: ViewSource, from: Cursor, limit: number): VisibleRow[] => {
  const rows: VisibleRow[] = [];
  for (let index = from.index; index < source.count() && rows.length < limit; index += 1) {
    const entry = source.at(index);
    const entryRows = source.rowsOf(entry);
    for (let row = index === from.index ? from.row : 0; row < entryRows.length && rows.length < limit; row += 1) {
      const found = entryRows[row];
      if (found !== undefined) rows.push({ entryId: entry.id, rowIndex: row, row: found });
    }
  }
  return rows;
};

const backward = (source: ViewSource, before: Cursor, limit: number): VisibleRow[] => {
  const rows: VisibleRow[] = [];
  for (let index = Math.min(before.index, source.count() - 1); index >= 0 && rows.length < limit; index -= 1) {
    const entry = source.at(index);
    const entryRows = source.rowsOf(entry);
    for (let row = (index === before.index ? before.row : entryRows.length) - 1; row >= 0 && rows.length < limit; row -= 1) {
      const found = entryRows[row];
      if (found !== undefined) rows.push({ entryId: entry.id, rowIndex: row, row: found });
    }
  }
  return rows.reverse();
};

const isFirstRow = (source: ViewSource, row: VisibleRow | undefined): boolean => row === undefined || (backward(source, { index: source.indexOfId(row.entryId) ?? 0, row: row.rowIndex }, 1).length === 0);

const isLastRow = (source: ViewSource, row: VisibleRow | undefined): boolean => {
  if (row === undefined) return true;
  return forward(source, { index: source.indexOfId(row.entryId) ?? 0, row: row.rowIndex + 1 }, 1).length === 0;
};

const windowFrom = (source: ViewSource, rows: VisibleRow[]): ViewWindow => {
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return EMPTY;
  return {
    rows,
    firstIndex: source.indexOfId(first.entryId) ?? 0,
    lastIndex: source.indexOfId(last.entryId) ?? 0,
    atTop: isFirstRow(source, first),
    atBottom: isLastRow(source, last),
  };
};

export const windowOf = (source: ViewSource, position: Position, height: number): ViewWindow => {
  if (position.following) return windowFrom(source, backward(source, endOf(source), height));
  const top = cursorOf(source, position.anchor);
  const below = forward(source, top, height);
  return windowFrom(source, below.length < height ? [...backward(source, top, height - below.length), ...below] : below);
};

export const clamped = (source: ViewSource, position: Position): Position => {
  if (position.anchor === undefined) return position;
  const cursor = cursorOf(source, position.anchor);
  if (cursor.row === position.anchor.rowOffset) return position;
  return { anchor: { entryId: position.anchor.entryId, rowOffset: cursor.row }, following: position.following };
};

const anchorOf = (row: VisibleRow | undefined): Anchor | undefined => (row === undefined ? undefined : { entryId: row.entryId, rowOffset: row.rowIndex });

const firstAnchor = (source: ViewSource): Anchor | undefined => anchorOf(forward(source, { index: 0, row: 0 }, 1)[0]);

export const moved = (source: ViewSource, position: Position, height: number, move: ViewportMove): Position => {
  if (move.kind === 'bottom') return { anchor: position.anchor, following: true };
  if (move.kind === 'top') {
    const window = windowOf(source, { anchor: firstAnchor(source), following: false }, height);
    return { anchor: anchorOf(window.rows[0]), following: window.atBottom };
  }
  const current = windowOf(source, position, height);
  const top = current.rows[0];
  if (top === undefined || move.rows === 0) return position;
  const cursor: Cursor = { index: source.indexOfId(top.entryId) ?? 0, row: top.rowIndex };
  const target = move.rows < 0 ? (backward(source, cursor, -move.rows)[0] ?? top) : (forward(source, cursor, move.rows + 1).at(-1) ?? top);
  const next = windowOf(source, { anchor: anchorOf(target), following: false }, height);
  return { anchor: anchorOf(next.rows[0]), following: next.atBottom };
};

export const VIEWPORT_CONTEXTS: readonly KeyContext[] = ['viewport'];

export const viewportMoveOfAction = (action: ActionId | undefined, height: number): ViewportMove | undefined => {
  const half = Math.max(1, Math.floor(height / 2));
  if (action === 'viewport.pageUp') return { kind: 'rows', rows: -half };
  if (action === 'viewport.pageDown') return { kind: 'rows', rows: half };
  if (action === 'viewport.top') return { kind: 'top' };
  if (action === 'viewport.bottom') return { kind: 'bottom' };
  return undefined;
};

export const viewportMoveOf = (event: TerminalEvent, height: number, keys: KeyTable): ViewportMove | undefined => {
  if (event.type === 'mouse') {
    if (event.kind !== 'wheel') return undefined;
    if (event.button === 'wheel-up') return { kind: 'rows', rows: -WHEEL_ROWS };
    return event.button === 'wheel-down' ? { kind: 'rows', rows: WHEEL_ROWS } : undefined;
  }
  return event.type === 'key' ? viewportMoveOfAction(keys.actionOf(VIEWPORT_CONTEXTS, event), height) : undefined;
};

export const thumbRow = (window: ViewWindow, count: number, height: number): number => {
  if (window.atBottom) return height - 1;
  return Math.min(height - 1, Math.floor((window.firstIndex * height) / Math.max(1, count)));
};
