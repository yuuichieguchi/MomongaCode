import { describe, expect, it } from 'vitest';
import { assistantTextRows as assistantTextRowsWith, rowsOfEntry as rowsOfEntryWith } from '../../src/tui/screen/entry-rows.ts';
import { createRowCache as createRowCacheWith } from '../../src/tui/screen/row-cache.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { displayWidth, logicalText, wrapLine, wrapText } from '../../src/tui/screen/wrap.ts';
import { appendEntry, foldEvent } from '../../src/tui/transcript.ts';
import { eventOf, randomText, seeded, storeOf, ROW_FACTS, ROW_RENDERERS } from './screen-fakes.ts';

const rowsOfEntry = (entry: Parameters<typeof rowsOfEntryWith>[0], width: number) => rowsOfEntryWith(entry, width, ROW_FACTS);
const assistantTextRows = (text: string, width: number) => assistantTextRowsWith(text, width, ROW_FACTS);
const createRowCache = (renderers: Parameters<typeof createRowCacheWith>[0] = ROW_RENDERERS) => createRowCacheWith(renderers);

const delta = (itemId: string, text: string) => ({ type: 'agent.message.delta', attempt: 0, itemId, text });

describe('display width', () => {
  it('counts a wide character and an emoji as two columns, a combining mark as none', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('漢字')).toBe(4);
    expect(displayWidth('👍')).toBe(2);
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('ｱ')).toBe(1);
  });
});

describe('wrapping', () => {
  it('breaks after a space where one fits, marks the continuation rows and puts the gutter in front of each', () => {
    const rows = wrapLine('alpha beta gamma', 13, { first: '> ', rest: '  ' });
    expect(rows.map((row) => row.text)).toEqual(['> alpha beta ', '  gamma']);
    expect(rows.map((row) => row.wrapped)).toEqual([false, true]);
    expect(rows.map((row) => row.prefixCols)).toEqual([2, 2]);
  });

  it('never splits a wide character across two rows', () => {
    const rows = wrapLine('a漢字漢', 4);
    expect(rows.map((row) => row.text)).toEqual(['a漢', '字漢']);
  });

  it('keeps every row within the width and gives the text back when the rows are joined (P2)', () => {
    const random = seeded(11);
    for (let round = 0; round < 300; round += 1) {
      const text = randomText(random, Math.floor(random() * 120));
      const width = 2 + Math.floor(random() * 40);
      const rows = wrapText(text, width);
      for (const row of rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(width);
      expect(logicalText(rows)).toBe(text);
    }
  });

  it('carries a bare URL as a link on every row it spans', () => {
    const rows = wrapLine('see https://example.test/a/long/path now', 16);
    const linked = rows.flatMap((row) => row.links ?? []);
    expect(linked.length).toBeGreaterThan(1);
    expect(new Set(linked.map((link) => link[2]))).toEqual(new Set(['https://example.test/a/long/path']));
  });
});

describe('the row cache', () => {
  const counting = () => {
    const calls: { kind: string; width: number; characters: number }[] = [];
    const cache = createRowCache({
      entryRows: (entry, width) => {
        calls.push({ kind: entry.kind, width, characters: 0 });
        return rowsOfEntry(entry, width);
      },
      assistantRows: (text, width) => {
        calls.push({ kind: 'assistant', width, characters: text.length });
        return assistantTextRows(text, width);
      },
    });
    return { cache, calls };
  };

  it('computes the rows of an entry once per width and version', () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: 'one two three four five six' });
    appendEntry(store, { kind: 'info', text: 'other' });
    const { cache, calls } = counting();
    cache.rowsOf(store.at(0), 10);
    cache.rowsOf(store.at(0), 10);
    expect(calls).toHaveLength(1);
    cache.rowsOf(store.at(0), 8);
    expect(calls.map((entry) => entry.width)).toEqual([10, 8]);
    cache.rowsOf(store.at(1), 8);
    expect(calls).toHaveLength(3);
  });

  it('recomputes an entry whose version moved and no other', () => {
    const store = storeOf([
      { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Read', kind: 'read', title: 'Read /a', rawInput: {} },
      { type: 'tool.call', callId: 'c2', providerCallId: 'p2', name: 'Read', kind: 'read', title: 'Read /b', rawInput: {} },
    ]);
    const { cache, calls } = counting();
    cache.rowsOf(store.at(0), 40);
    cache.rowsOf(store.at(1), 40);
    foldEvent(store, eventOf({ type: 'tool.started', callId: 'c2', idemKey: 'k' }));
    cache.rowsOf(store.at(0), 40);
    cache.rowsOf(store.at(1), 40);
    expect(calls).toHaveLength(3);
  });

  it('re-wraps only the tail after the last blank line of a growing answer and gives the rows a fresh computation gives', () => {
    const store = storeOf([delta('a', 'first paragraph of the answer\n\n```\ncode\n\nstill code\n```\n\nsecond ')]);
    const { cache, calls } = counting();
    cache.rowsOf(store.at(0), 12);
    calls.length = 0;
    foldEvent(store, eventOf(delta('a', 'paragraph grows')));
    const rows = cache.rowsOf(store.at(0), 12);
    expect(calls.map((entry) => entry.characters)).toEqual(['second paragraph grows'.length]);
    expect(rows).toEqual(createRowCache().rowsOf(store.at(0), 12));
    expect(logicalText(rows)).toBe('first paragraph of the answer\n\ncode\n\nstill code\n\nsecond paragraph grows');
  });

  it('gives the same rows for any way an answer is cut into deltas', () => {
    const random = seeded(3);
    for (let round = 0; round < 50; round += 1) {
      const text = randomText(random, 200).replaceAll('z', '\n\n');
      const whole = storeOf([delta('a', text)]);
      const pieces = createTranscriptStore();
      const cache = createRowCache();
      let from = 0;
      while (from < text.length) {
        const to = Math.min(text.length, from + 1 + Math.floor(random() * 30));
        foldEvent(pieces, eventOf(delta('a', text.slice(from, to))));
        cache.rowsOf(pieces.at(0), 17);
        from = to;
      }
      if (text.length > 0) expect(cache.rowsOf(pieces.at(0), 17)).toEqual(createRowCache().rowsOf(whole.at(0), 17));
    }
  });

  it('keeps rows only for the entries within the margin around the window, and the entry it is told to keep', () => {
    const store = createTranscriptStore();
    for (let index = 0; index < 100; index += 1) appendEntry(store, { kind: 'info', text: `line ${index}` });
    const { cache } = counting();
    for (let index = 0; index < 100; index += 1) cache.rowsOf(store.at(index), 40);
    expect(cache.size()).toBe(100);
    cache.retain(store, 50, 59, 10, store.at(99).id);
    expect(cache.size()).toBe(10 + 10 + 10 + 1);
  });
});
