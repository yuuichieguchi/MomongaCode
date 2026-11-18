import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { createHistoryFeed } from '../../src/tui/screen/history-feed.ts';
import { MARKDOWN_UNIT_BYTES, NOTHING_SCANNED, START_OF_TEXT, markdownRows, parseMarkdown } from '../../src/tui/screen/markdown.ts';
import { createRowCache } from '../../src/tui/screen/row-cache.ts';
import type { RowRenderers } from '../../src/tui/screen/row-cache.ts';
import { extractSelection } from '../../src/tui/screen/selection.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { TranscriptStore } from '../../src/tui/screen/store.ts';
import { openThoughtRows, thoughtRows } from '../../src/tui/screen/thought.ts';
import type { ThoughtEntry } from '../../src/tui/screen/thought.ts';
import { sourceOf } from '../../src/tui/screen/viewport.ts';
import { inertText, wrapText } from '../../src/tui/screen/wrap.ts';
import type { Row } from '../../src/tui/screen/wrap.ts';
import { appendEntry, foldEvent } from '../../src/tui/transcript.ts';
import { eventOf, manualSchedule, seeded, storeOf, ROW_RENDERERS } from './screen-fakes.ts';
import { NO_FILE_LINKS } from '../../src/tui/screen/file-links.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const texts = (rows: readonly Row[]): string[] => rows.map((row) => row.text);
const delta = (itemId: string, text: string) => ({ type: 'agent.message.delta', attempt: 0, itemId, text });
const bytesOf = (text: string): number => Buffer.byteLength(text);

const SECTION = ['## A heading with `code`', '', 'A paragraph with **strong** text and a [link](https://example.test/page).', 'its second line', '', '- item one', '- item *two*', '', '```ts', 'const a = 1;', 'const b = "**not bold**";', '```', '', '| name | value |', '|------|-------|', '| a    | 1     |', '', '> quoted', ''].join('\n');

const largeAnswer = (bytes: number): string => `${SECTION}\n`.repeat(Math.ceil(bytes / (SECTION.length + 1)));

const settledStore = (text: string): TranscriptStore => {
  const store = createTranscriptStore();
  appendEntry(store, { kind: 'assistant', itemId: 'a', text, open: false }, 'a');
  return store;
};

type UnitCall = { unit: boolean; bytes: number; given: number };

const recording = (): { renderers: RowRenderers; calls: UnitCall[] } => {
  const calls: UnitCall[] = [];
  return {
    calls,
    renderers: {
      ...ROW_RENDERERS,
      answerRows: (text, from, width, reading) => {
        const parsed = ROW_RENDERERS.answerRows(text, from, width, reading);
        calls.push({ unit: reading.unit, bytes: bytesOf(text.slice(from.characters, parsed.point.characters)), given: text.length - from.characters });
        return parsed;
      },
    },
  };
};

describe('a markdown entry larger than one unit', () => {
  const text = largeAnswer(1024 * 1024);

  it('shows its first unit parsed and the rest as plain wrapped rows in the first frame, and is parsed one unit per turn of the event loop', () => {
    const store = settledStore(text);
    const { renderers, calls } = recording();
    const turns = manualSchedule();
    const cache = createRowCache(renderers, turns.schedule);
    const plain = wrapText(inertText(text), 60, { links: false });
    const first = [...cache.rowsOf(store.at(0), 60)];
    expect(calls).toHaveLength(1);
    expect(first[0]?.text).toBe('A heading with code');
    expect(first.slice(-500)).toEqual(plain.slice(-500));
    expect(cache.parsed(store.at(0), 60)).toBe(false);
    expect(turns.waiting()).toBe(1);

    turns.turn();
    expect(calls).toHaveLength(2);
    expect(turns.waiting()).toBe(1);
    expect(turns.rowsChanged()).toBe(1);
    expect(cache.rowsOf(store.at(0), 60).slice(-500)).toEqual(plain.slice(-500));

    const taken = 1 + turns.drain();
    const units = calls.filter((call) => call.unit);
    expect(taken + 1).toBeGreaterThanOrEqual(Math.floor(bytesOf(text) / MARKDOWN_UNIT_BYTES));
    expect(taken).toBeLessThanOrEqual(2 * Math.ceil(bytesOf(text) / MARKDOWN_UNIT_BYTES));
    expect(units).toHaveLength(taken + 1);
    for (const call of units) expect(call.bytes).toBeLessThanOrEqual(MARKDOWN_UNIT_BYTES);
    expect(turns.rowsChanged()).toBe(taken);
    expect(cache.parsed(store.at(0), 60)).toBe(true);
    expect(cache.rowsOf(store.at(0), 60)).toEqual(markdownRows(text, 60));
  });

  it('parses an entry of one unit at once, with no turn', () => {
    const small = largeAnswer(MARKDOWN_UNIT_BYTES / 2);
    const store = settledStore(small);
    const turns = manualSchedule();
    const cache = createRowCache(ROW_RENDERERS, turns.schedule);
    expect(cache.rowsOf(store.at(0), 60)).toEqual(markdownRows(small, 60));
    expect(cache.parsed(store.at(0), 60)).toBe(true);
    expect(turns.waiting()).toBe(0);
  });

  it('gives the rows of the whole text for any unit cut: a parse resumed at each point it stopped equals one parse', () => {
    const whole = markdownRows(text.slice(0, 200_000), 47);
    const rows: Row[] = [];
    let point = START_OF_TEXT;
    for (;;) {
      const parsed = parseMarkdown(text.slice(0, 200_000), point, 47, { tables: 'grid', references: NOTHING_SCANNED.references, files: NO_FILE_LINKS, settled: true, unit: true });
      rows.length -= parsed.retract;
      rows.push(...parsed.rows);
      point = parsed.point;
      if (parsed.tail !== undefined) {
        rows.push(...parsed.tail);
        break;
      }
    }
    expect(rows).toEqual(whole);
  });

  it('keeps an entry whose parse has started until its units finish, and stops when it is closed', () => {
    const store = settledStore(text);
    appendEntry(store, { kind: 'info', text: 'after' });
    const turns = manualSchedule();
    const cache = createRowCache(ROW_RENDERERS, turns.schedule);
    cache.rowsOf(store.at(0), 60);
    cache.retain(store, 1, 1, 0);
    expect(cache.size()).toBe(1);
    turns.turn();
    expect(turns.waiting()).toBe(1);
    cache.close();
    turns.drain();
    expect(cache.parsed(store.at(0), 60)).toBe(false);
  });

  it('is not handed to the scrollback before its units finish', () => {
    const store = settledStore(text);
    const turns = manualSchedule();
    const source = sourceOf(store, createRowCache(ROW_RENDERERS, turns.schedule), 60);
    const feed = createHistoryFeed();
    expect(feed.next(source, (index) => index < 1)).toEqual([]);
    expect(feed.pending(source, (index) => index < 1)).toBe(true);
    turns.drain();
    expect(feed.next(source, (index) => index < 1)[0]?.text).toBe('A heading with code');
  });
});

describe('an open answer', () => {
  it('re-parses only the open line of a fenced block of 200 lines', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index};`);
    const store = storeOf([delta('a', `Intro\n\n\`\`\`ts\n${lines.join('\n')}\npartial`)]);
    const { renderers, calls } = recording();
    const cache = createRowCache(renderers, manualSchedule().schedule);
    cache.rowsOf(store.at(0), 40);
    calls.length = 0;
    foldEvent(store, eventOf(delta('a', ' line')));
    const rows = cache.rowsOf(store.at(0), 40);
    expect(calls.map((call) => call.given)).toEqual(['partial line'.length]);
    expect(rows.at(-1)?.text).toBe('  partial line');
    foldEvent(store, eventOf(delta('a', '\n```\nafter the block\n\nnext')));
    calls.length = 0;
    cache.rowsOf(store.at(0), 40);
    foldEvent(store, eventOf(delta('a', ' grows')));
    expect(texts(cache.rowsOf(store.at(0), 40)).slice(-3)).toEqual(['after the block', '', 'next grows']);
    expect(calls.at(-1)?.given).toBe('next grows'.length);
  });

  it('gives the rows of one parse of the whole text for any way a large answer is cut into deltas', () => {
    const random = seeded(11);
    const answer = largeAnswer(3 * MARKDOWN_UNIT_BYTES);
    const whole = markdownRows(answer, 33);
    const pieces = createTranscriptStore();
    const turns = manualSchedule();
    const cache = createRowCache(ROW_RENDERERS, turns.schedule);
    for (let from = 0; from < answer.length; ) {
      const to = Math.min(answer.length, from + 1 + Math.floor(random() * 4000));
      foldEvent(pieces, eventOf(delta('a', answer.slice(from, to))));
      cache.rowsOf(pieces.at(0), 33);
      if (random() < 0.3) turns.turn();
      from = to;
    }
    turns.drain();
    expect(cache.rowsOf(pieces.at(0), 33)).toEqual(whole);
    cache.rowsOf(pieces.at(0), 20);
    turns.drain();
    expect(cache.rowsOf(pieces.at(0), 20)).toEqual(markdownRows(answer, 20));
  });

  it('starts again when the text it holds is no longer the start of the entry', () => {
    const store = settledStore('first\n\nsecond');
    const cache = createRowCache(ROW_RENDERERS, manualSchedule().schedule);
    cache.rowsOf(store.at(0), 40);
    store.change('a', (entry) => (entry.kind === 'assistant' ? { ...entry, text: 'other\n\nsecond' } : entry));
    expect(texts(cache.rowsOf(store.at(0), 40))).toEqual(['other', '', 'second']);
  });
});

describe('fences', () => {
  it('has one fence pattern in the terminal UI', () => {
    const root = path.resolve(import.meta.dirname, '../../src/tui');
    const found: string[] = [];
    for (const name of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(name)) continue;
      fs.readFileSync(path.join(root, name), 'utf8')
        .split('\n')
        .forEach((line) => {
          if (/`{3}|~{3}|[`~]\{3/.test(line)) found.push(name);
        });
    }
    expect(found).toEqual([path.join('screen', 'markdown.ts')]);
  });

  it('closes a block only at a fence of its own mark that is at least as long and carries no text', () => {
    const rows = markdownRows('````md\n```ts\ninner\n```\n~~~\n````\nafter', 40);
    expect(texts(rows)).toEqual(['  md', '  ```ts', '  inner', '  ```', '  ~~~', 'after']);
    expect(texts(markdownRows('```one``` two', 40))).toEqual(['one two']);
  });

  it('marks the language row as a label, and a copy of the block leaves it out', () => {
    const store = settledStore('```typescript\nconst a = 1;\nconst b = 2;\n```');
    const source = sourceOf(store, createRowCache(ROW_RENDERERS, manualSchedule().schedule), 40);
    const rows = source.rowsOf(store.at(0));
    expect(rows.map((row) => row.kind)).toEqual(['label', undefined, undefined]);
    const { id } = store.at(0);
    const copied = extractSelection(source, { anchor: { entryId: id, rowIndex: 0, col: 0 }, head: { entryId: id, rowIndex: 2, col: Number.POSITIVE_INFINITY } }, 1024);
    expect(copied.text).toBe('const a = 1;\nconst b = 2;');
  });
});

describe('a table larger than one unit', () => {
  it('is drawn as records, row by row, and each unit stays within the bound', () => {
    const body = Array.from({ length: 600 }, (_, index) => `| name ${index} | some value of row ${index} |`);
    const table = ['| name | value |', '|---|---|', ...body, '', 'after'].join('\n');
    expect(bytesOf(table)).toBeGreaterThan(MARKDOWN_UNIT_BYTES);
    const rows = markdownRows(table, 60);
    expect(texts(rows).slice(0, 5)).toEqual(['name: name 0', 'value: some value of row 0', '', 'name: name 1', 'value: some value of row 1']);
    expect(texts(rows).slice(-4)).toEqual(['name: name 599', 'value: some value of row 599', '', 'after']);
    expect(rows.some((row) => row.text.includes('│'))).toBe(false);
    let point = START_OF_TEXT;
    for (;;) {
      const parsed = parseMarkdown(table, point, 60, { tables: 'grid', references: NOTHING_SCANNED.references, files: NO_FILE_LINKS, settled: true, unit: true });
      expect(bytesOf(table.slice(point.characters, parsed.point.characters))).toBeLessThanOrEqual(MARKDOWN_UNIT_BYTES);
      point = parsed.point;
      if (parsed.tail !== undefined) break;
    }
  });
});

describe('the inline marks of one line at the unit bound', () => {
  const searchesOf = (text: string): number => {
    const search = vi.spyOn(String.prototype, 'indexOf');
    try {
      markdownRows(text, 80);
      return search.mock.calls.length;
    } finally {
      search.mockRestore();
    }
  };

  it('are found with a number of searches linear in the line, for marks that never close and code marks of every length', () => {
    const size = MARKDOWN_UNIT_BYTES - 64;
    const filled = (piece: string): string => piece.repeat(Math.floor(size / piece.length));
    const everyLength = Array.from({ length: 400 }, (_, index) => '`'.repeat(index + 1)).join(' ').slice(0, size);
    for (const line of [filled('*a _b '), filled('*_'), filled('* a* '), filled('` `` '), filled('*a **b '), filled('[a]('), everyLength]) expect(searchesOf(line)).toBeLessThan(4 * line.length);
  });
});

describe('an open thought', () => {
  const thought = (text: string): ThoughtEntry => ({ kind: 'thought', itemId: 't', text, startedAt: 0, expanded: false, window: 3 });

  it('wraps only the lines that arrived since the rows it was given, and shows what a fresh wrap shows', () => {
    const random = seeded(5);
    const text = Array.from({ length: 60 }, (_, index) => `line ${index} ${'word '.repeat(Math.floor(random() * 12))}`).join('\n');
    let before = openThoughtRows(thought(''), 24, undefined);
    for (let from = 0; from < text.length; ) {
      const to = Math.min(text.length, from + 1 + Math.floor(random() * 40));
      before = openThoughtRows(thought(text.slice(0, to)), 24, before);
      expect(before.rows).toEqual(thoughtRows(thought(text.slice(0, to)), 24));
      from = to;
    }
  });

  it('does not read the text before the last line end it has wrapped', () => {
    const held = openThoughtRows(thought('first line of the thought\nsecond line\nthird'), 24, undefined);
    expect(held.characters).toBe('first line of the thought\nsecond line\n'.length);
    const grown = openThoughtRows(thought(`${'#'.repeat(held.characters)}third line grows`), 24, held);
    expect(grown.rows).toEqual(thoughtRows(thought('first line of the thought\nsecond line\nthird line grows'), 24));
  });
});
