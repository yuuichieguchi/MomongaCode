import { describe, expect, it } from 'vitest';
import { WHEEL_ROWS } from '../../src/tui/screen/constants.ts';
import { createRowCache as createRowCacheWith } from '../../src/tui/screen/row-cache.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { TranscriptStore } from '../../src/tui/screen/store.ts';
import { clamped, FOLLOWING, moved, sourceOf, thumbRow, viewportMoveOf as viewportMoveOfWith, windowOf } from '../../src/tui/screen/viewport.ts';
import type { Position } from '../../src/tui/screen/viewport.ts';
import { appendEntry } from '../../src/tui/transcript.ts';
import { ROW_RENDERERS, ROW_SCHEDULE } from './screen-fakes.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';

const createRowCache = (renderers: Parameters<typeof createRowCacheWith>[0] = ROW_RENDERERS) => createRowCacheWith(renderers, ROW_SCHEDULE);
const viewportMoveOf = (event: Parameters<typeof viewportMoveOfWith>[0], height: number) => viewportMoveOfWith(event, height, DEFAULT_KEY_TABLE);

const filled = (count: number, text = (index: number) => `line ${index}`): TranscriptStore => {
  const store = createTranscriptStore();
  for (let index = 0; index < count; index += 1) appendEntry(store, { kind: 'info', text: text(index) });
  return store;
};

const texts = (store: TranscriptStore, position: Position, height: number, width = 40): string[] => windowOf(sourceOf(store, createRowCache(), width), position, height).rows.map((row) => row.row.text);

const plain = { ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false };

describe('the viewport', () => {
  it('follows the end: the last rows are shown and new entries move into view', () => {
    const store = filled(30);
    expect(texts(store, FOLLOWING, 5)).toEqual(['line 25', 'line 26', 'line 27', 'line 28', 'line 29']);
    appendEntry(store, { kind: 'info', text: 'new' });
    expect(texts(store, FOLLOWING, 5).at(-1)).toBe('new');
  });

  it('shows a transcript shorter than the viewport from its top', () => {
    const store = filled(2);
    const window = windowOf(sourceOf(store, createRowCache(), 40), FOLLOWING, 5);
    expect(window.rows.map((row) => row.row.text)).toEqual(['line 0', 'line 1']);
    expect(window.atTop && window.atBottom).toBe(true);
  });

  it('scrolls by rows across entries, stops following when it leaves the end and follows again when it returns', () => {
    const store = filled(30, (index) => `first ${index}\nsecond ${index}`);
    const source = sourceOf(store, createRowCache(), 40);
    const up = moved(source, FOLLOWING, 4, { kind: 'rows', rows: -3 });
    expect(up.following).toBe(false);
    expect(windowOf(source, up, 4).rows.map((row) => row.row.text)).toEqual(['second 26', 'first 27', 'second 27', 'first 28']);
    expect(up.anchor).toEqual({ entryId: store.at(26).id, rowOffset: 1 });
    appendEntry(store, { kind: 'info', text: 'new' });
    expect(windowOf(source, up, 4).rows[0]?.row.text).toBe('second 26');
    const down = moved(source, up, 4, { kind: 'rows', rows: 50 });
    expect(down.following).toBe(true);
    expect(windowOf(source, down, 4).rows.at(-1)?.row.text).toBe('new');
  });

  it('measures only the entries it crosses when it scrolls', () => {
    const store = filled(1000);
    const measured = new Set<number>();
    const cache = createRowCache();
    const source = { ...sourceOf(store, cache, 40), rowsOf: (entry: ReturnType<TranscriptStore['at']>) => (measured.add(entry.id), cache.rowsOf(entry, 40)) };
    const position = moved(source, FOLLOWING, 10, { kind: 'rows', rows: -5 });
    windowOf(source, position, 10);
    expect(measured.size).toBeLessThanOrEqual(16);
  });

  it('jumps to the top and to the bottom without measuring what lies between', () => {
    const store = filled(1000);
    const source = sourceOf(store, createRowCache(), 40);
    const top = moved(source, FOLLOWING, 5, { kind: 'top' });
    expect(top).toEqual({ anchor: { entryId: store.at(0).id, rowOffset: 0 }, following: false });
    expect(windowOf(source, top, 5).rows[0]?.row.text).toBe('line 0');
    expect(moved(source, top, 5, { kind: 'bottom' }).following).toBe(true);
  });

  it('keeps the entry of the anchor after a rewrap and clamps the row to its last row', () => {
    const store = filled(10, (index) => `${index} aaaa bbbb cccc dddd eeee ffff`);
    const narrow = sourceOf(store, createRowCache(), 10);
    const position: Position = { anchor: { entryId: store.at(3).id, rowOffset: 2 }, following: false };
    expect(clamped(narrow, position)).toEqual(position);
    const wide = sourceOf(store, createRowCache(), 80);
    expect(clamped(wide, position)).toEqual({ anchor: { entryId: store.at(3).id, rowOffset: 0 }, following: false });
    expect(clamped(wide, { ...position, following: true }).following).toBe(true);
  });

  it('fills the window from above when the anchor is too near the end to fill it', () => {
    const store = filled(10);
    const position: Position = { anchor: { entryId: store.at(8).id, rowOffset: 0 }, following: false };
    expect(texts(store, position, 5)).toEqual(['line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
  });

  it('maps the viewport keys and the wheel to moves: half a viewport, top, bottom, three rows a notch', () => {
    expect(viewportMoveOf({ type: 'key', name: 'pageup', ...plain }, 20)).toEqual({ kind: 'rows', rows: -10 });
    expect(viewportMoveOf({ type: 'key', name: 'pagedown', ...plain }, 21)).toEqual({ kind: 'rows', rows: 10 });
    expect(viewportMoveOf({ type: 'key', name: 'home', ...plain, ctrl: true }, 20)).toEqual({ kind: 'top' });
    expect(viewportMoveOf({ type: 'key', name: 'end', ...plain, ctrl: true }, 20)).toEqual({ kind: 'bottom' });
    expect(viewportMoveOf({ type: 'key', name: 'end', ...plain }, 20)).toEqual({ kind: 'bottom' });
    expect(viewportMoveOf({ type: 'key', name: 'home', ...plain }, 20)).toBeUndefined();
    expect(viewportMoveOf({ type: 'mouse', kind: 'wheel', button: 'wheel-up', col: 1, row: 1, ...plain }, 20)).toEqual({ kind: 'rows', rows: -WHEEL_ROWS });
    expect(viewportMoveOf({ type: 'mouse', kind: 'wheel', button: 'wheel-down', col: 1, row: 1, ...plain }, 20)).toEqual({ kind: 'rows', rows: WHEEL_ROWS });
    expect(WHEEL_ROWS).toBe(3);
  });

  it('places the scrollbar thumb by the index of the first visible entry over the number of entries', () => {
    const store = filled(100);
    const source = sourceOf(store, createRowCache(), 40);
    expect(thumbRow(windowOf(source, FOLLOWING, 10), 100, 10)).toBe(9);
    expect(thumbRow(windowOf(source, moved(source, FOLLOWING, 10, { kind: 'top' }), 10), 100, 10)).toBe(0);
    const middle: Position = { anchor: { entryId: store.at(50).id, rowOffset: 0 }, following: false };
    expect(thumbRow(windowOf(source, middle, 10), 100, 10)).toBe(5);
  });
});
