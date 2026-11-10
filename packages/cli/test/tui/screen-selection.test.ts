import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { DOUBLE_CLICK_MS } from '../../src/tui/screen/constants.ts';
import { createRowCache as createRowCacheWith } from '../../src/tui/screen/row-cache.ts';
import { createClickCounter, extractSelection, lineSelection, selectedColumns, wordSelection } from '../../src/tui/screen/selection.ts';
import type { Selection } from '../../src/tui/screen/selection.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { sourceOf } from '../../src/tui/screen/viewport.ts';
import { displayWidth } from '../../src/tui/screen/wrap.ts';
import { appendEntry } from '../../src/tui/transcript.ts';
import { randomText, seeded, ROW_RENDERERS } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const createRowCache = (renderers: Parameters<typeof createRowCacheWith>[0] = ROW_RENDERERS) => createRowCacheWith(renderers);

const sourceWith = (texts: readonly string[], width: number) => {
  const store = createTranscriptStore();
  for (const text of texts) appendEntry(store, { kind: 'user', text });
  return { store, source: sourceOf(store, createRowCache(), width) };
};

const CAP = 1024 * 1024;

describe('selection', () => {
  it('joins soft-wrapped rows without a newline, hard rows with one, and leaves the gutter out', () => {
    const { store, source } = sourceWith(['alpha beta gamma\nsecond line', 'next'], 13);
    const rows = source.rowsOf(store.at(0));
    expect(rows.map((row) => row.text)).toEqual(['> alpha beta ', '  gamma', '  second line']);
    const all: Selection = { anchor: { entryId: store.at(0).id, rowIndex: 0, col: 0 }, head: { entryId: store.at(1).id, rowIndex: 0, col: 99 } };
    expect(extractSelection(source, all, CAP)).toEqual({ text: 'alpha beta gamma\nsecond line\nnext', bytes: 33, complete: true });
  });

  it('takes the cells from the anchor to the head inclusive, and the same text when the two are swapped', () => {
    const { store, source } = sourceWith(['alpha beta gamma'], 40);
    const id = store.at(0).id;
    const forward: Selection = { anchor: { entryId: id, rowIndex: 0, col: 4 }, head: { entryId: id, rowIndex: 0, col: 8 } };
    expect(extractSelection(source, forward, CAP).text).toBe('pha b');
    expect(extractSelection(source, { anchor: forward.head, head: forward.anchor }, CAP).text).toBe('pha b');
  });

  it('extracts the substring of the logical text for any pair of points, in either direction (P3)', () => {
    const random = seeded(5);
    for (let round = 0; round < 200; round += 1) {
      const text = randomText(random, 5 + Math.floor(random() * 80)).replace(/ +(\n|$)/g, '$1').replace(/^\n+|\n+$/g, '') || 'x';
      const { store, source } = sourceWith([text], 6 + Math.floor(random() * 20));
      const rows = source.rowsOf(store.at(0));
      const id = store.at(0).id;
      const point = () => {
        const rowIndex = Math.floor(random() * rows.length);
        return { entryId: id, rowIndex, col: Math.floor(random() * (displayWidth(rows[rowIndex]?.text ?? '') + 2)) };
      };
      const selection = { anchor: point(), head: point() };
      const forward = extractSelection(source, selection, CAP).text;
      expect(extractSelection(source, { anchor: selection.head, head: selection.anchor }, CAP).text).toBe(forward);
      expect(text.replace(/ +\n/g, '\n')).toContain(forward);
    }
  });

  it('selects a whole wide character when the cell is its second half', () => {
    const { store, source } = sourceWith(['漢字'], 40);
    const id = store.at(0).id;
    expect(extractSelection(source, { anchor: { entryId: id, rowIndex: 0, col: 3 }, head: { entryId: id, rowIndex: 0, col: 3 } }, CAP).text).toBe('漢');
  });

  it('selects the word under a double click and the logical line under a triple click', () => {
    const { store, source } = sourceWith(['alpha beta gamma delta'], 14);
    const id = store.at(0).id;
    const word = wordSelection(source, { entryId: id, rowIndex: 0, col: 9 });
    expect(extractSelection(source, word, CAP).text).toBe('beta');
    const line = lineSelection(source, { entryId: id, rowIndex: 1, col: 3 });
    expect(extractSelection(source, line, CAP).text).toBe('alpha beta gamma delta');
  });

  it('stops at the cap and says the extract is not complete', () => {
    const { store, source } = sourceWith(['aaaa bbbb cccc dddd'], 40);
    const id = store.at(0).id;
    const all: Selection = { anchor: { entryId: id, rowIndex: 0, col: 0 }, head: { entryId: id, rowIndex: 0, col: 99 } };
    const cut = extractSelection(source, all, 10);
    expect(cut.complete).toBe(false);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(10);
    expect(cut.bytes).toBe(19);
  });

  it('gives the highlighted columns of a row, or none outside the selection', () => {
    const { store } = sourceWith(['alpha beta gamma\nsecond'], 40);
    const id = store.at(0).id;
    const selection: Selection = { anchor: { entryId: id, rowIndex: 0, col: 4 }, head: { entryId: id, rowIndex: 1, col: 3 } };
    expect(selectedColumns(selection, id, 0)).toEqual([4, Number.POSITIVE_INFINITY]);
    expect(selectedColumns(selection, id, 1)).toEqual([0, 3]);
    expect(selectedColumns(selection, id + 1, 0)).toBeUndefined();
  });

  it('counts clicks on one cell that follow each other within the double-click gap', () => {
    let now = 0;
    const count = createClickCounter(() => now);
    const point = { entryId: 1, rowIndex: 0, col: 3 };
    expect(count(point)).toBe(1);
    now += DOUBLE_CLICK_MS;
    expect(count(point)).toBe(2);
    now += 10;
    expect(count(point)).toBe(3);
    now += 10;
    expect(count(point)).toBe(1);
    now += DOUBLE_CLICK_MS + 1;
    expect(count(point)).toBe(1);
    now += 1;
    expect(count({ ...point, col: 4 })).toBe(1);
    expect(DOUBLE_CLICK_MS).toBe(400);
  });
});
