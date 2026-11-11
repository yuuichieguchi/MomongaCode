import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { assistantTextRows as assistantTextRowsWith, rowsOfEntry as rowsOfEntryWith } from '../../src/tui/screen/entry-rows.ts';
import { MARKDOWN_UNIT_BYTES, markdownRows } from '../../src/tui/screen/markdown.ts';
import { createRowCache as createRowCacheWith } from '../../src/tui/screen/row-cache.ts';
import { hyperlink, piecesOf } from '../../src/tui/screen/row-text.tsx';
import { indexRangeOf } from '../../src/tui/screen/selection.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { displayWidth, logicalText } from '../../src/tui/screen/wrap.ts';
import type { Row } from '../../src/tui/screen/wrap.ts';
import { foldEvent } from '../../src/tui/transcript.ts';
import { eventOf, seeded, storeOf, ROW_FACTS, ROW_RENDERERS, ROW_SCHEDULE } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const rowsOfEntry = (entry: Parameters<typeof rowsOfEntryWith>[0], width: number) => rowsOfEntryWith(entry, width, ROW_FACTS);
const assistantTextRows = (text: string, width: number) => assistantTextRowsWith(text, width, ROW_FACTS);
const createRowCache = (renderers: Parameters<typeof createRowCacheWith>[0] = ROW_RENDERERS) => createRowCacheWith(renderers, ROW_SCHEDULE);

const texts = (rows: readonly Row[]): string[] => rows.map((row) => row.text);
const spans = (rows: readonly Row[]): unknown[] => rows.map((row) => row.spans);
const delta = (itemId: string, text: string) => ({ type: 'agent.message.delta', attempt: 0, itemId, text });

describe('markdown text styles', () => {
  it('shows a heading without its marks, in bold', () => {
    const rows = markdownRows('# Title\n### Sub *part* ##', 40);
    expect(texts(rows)).toEqual(['Title', 'Sub part']);
    expect(spans(rows)).toEqual([[[0, 5, 'bold']], [[4, 8, 'italic'], [0, 8, 'bold']]]);
  });

  it('removes the marks of strong, emphasis and inline code, gives code its token and keeps what is inside a code span literal', () => {
    const rows = markdownRows('a **b** *c* __d__ _e_ `**f**` snake_case_name 2 * 3 * 4', 80);
    expect(texts(rows)).toEqual(['a b c d e **f** snake_case_name 2 * 3 * 4']);
    expect(spans(rows)).toEqual([[[2, 3, 'bold'], [4, 5, 'italic'], [6, 7, 'bold'], [8, 9, 'italic'], [10, 15, 'code']]]);
  });

  it('keeps an unclosed mark, an escaped mark and raw HTML as text', () => {
    expect(texts(markdownRows('**open and `tick and \\*star\\* <b>x</b>', 80))).toEqual(['**open and `tick and *star* <b>x</b>']);
  });

  it('carries a style across the rows of a wrapped line at each width', () => {
    const wide = markdownRows('alpha **beta gamma** delta', 12);
    expect(texts(wide)).toEqual(['alpha beta ', 'gamma delta']);
    expect(spans(wide)).toEqual([[[6, 11, 'bold']], [[0, 5, 'bold']]]);
    expect(wide.map((row) => row.wrapped)).toEqual([false, true]);
    const narrow = markdownRows('alpha **beta gamma** delta', 8);
    expect(texts(narrow)).toEqual(['alpha ', 'beta ', 'gamma ', 'delta']);
    expect(spans(narrow)).toEqual([[], [[0, 5, 'bold']], [[0, 5, 'bold']], []]);
  });

  it('keeps each source line on its own row and a blank line as an empty row', () => {
    expect(texts(markdownRows('one\ntwo\n\nthree', 40))).toEqual(['one', 'two', '', 'three']);
  });
});

describe('markdown code blocks', () => {
  it('shows a fenced block without its fences, indented two columns, with the language tag dim and the code literal in the colours of its language', () => {
    const rows = markdownRows('```ts\nconst a = **1**;\n\n  [b](https://c.test)\n```\nafter', 40);
    expect(texts(rows)).toEqual(['  ts', '  const a = **1**;', '  ', '    [b](https://c.test)', 'after']);
    expect(spans(rows)).toEqual([[[2, 4, 'dim']], [[2, 7, 'accent'], [7, 14, 'code'], [14, 15, 'warning'], [15, 18, 'code']], [], [[2, 14, 'code'], [14, 23, 'dim'], [14, 23, 'italic']], []]);
    expect(rows.map((row) => row.prefixCols)).toEqual([2, 2, 2, 2, 0]);
    expect(rows.every((row) => row.links === undefined)).toBe(true);
    expect(logicalText(rows.slice(1, 4))).toBe('const a = **1**;\n\n  [b](https://c.test)');
  });

  it('wraps a long code line under the same indent and shows a block that is still open', () => {
    const rows = markdownRows('~~~\nabcdefghij klm', 10);
    expect(texts(rows)).toEqual(['  abcdefgh', '  ij klm']);
    expect(rows.map((row) => row.wrapped)).toEqual([false, true]);
  });
});

describe('markdown blocks', () => {
  it('puts the quote gutter in front of every row of a quoted line', () => {
    const rows = markdownRows('> alpha *beta* gamma\n>> deep', 11);
    expect(texts(rows)).toEqual(['│ alpha ', '│ beta ', '│ gamma', '│ │ deep']);
    expect(spans(rows)).toEqual([[[0, 2, 'dim']], [[0, 2, 'dim'], [2, 6, 'italic']], [[0, 2, 'dim']], [[0, 4, 'dim']]]);
    expect(rows.map((row) => row.prefixCols)).toEqual([2, 2, 2, 4]);
  });

  it('shows list markers, keeps the nesting and hangs the continuation rows under the text', () => {
    const rows = markdownRows('- one\n  * two\n1. three\n- alpha beta gamma', 9);
    expect(texts(rows)).toEqual(['• one', '  • two', '1. three', '• alpha ', '  beta ', '  gamma']);
    expect(spans(rows)).toEqual([[[0, 2, 'dim']], [[0, 4, 'dim']], [[0, 3, 'dim']], [[0, 2, 'dim']], [[0, 2, 'dim']], [[0, 2, 'dim']]]);
    expect(rows.map((row) => row.prefixCols)).toEqual([2, 4, 3, 2, 2, 2]);
  });

  it('draws a rule across the width', () => {
    for (const width of [10, 23]) {
      const rows = markdownRows('---\n* * *', width);
      expect(texts(rows)).toEqual(['─'.repeat(width), '─'.repeat(width)]);
      expect(spans(rows)).toEqual([[[0, width, 'dim']], [[0, width, 'dim']]]);
    }
  });
});

describe('markdown tables', () => {
  it('draws a grid at the natural column widths when it fits', () => {
    const rows = markdownRows('| a | b |\n|---|:--:|\n| 1 | **22** |\nafter', 40);
    expect(texts(rows)).toEqual(['┌───┬────┐', '│ a │ b  │', '├───┼────┤', '│ 1 │ 22 │', '└───┴────┘', 'after']);
    expect(rows[1]?.spans).toEqual([[0, 1, 'dim'], [2, 3, 'bold'], [4, 5, 'dim'], [6, 7, 'bold'], [9, 10, 'dim']]);
    expect(rows[3]?.spans).toEqual([[0, 1, 'dim'], [4, 5, 'dim'], [6, 8, 'bold'], [9, 10, 'dim']]);
    expect(rows[0]?.spans).toEqual([[0, 10, 'dim']]);
  });

  it('wraps the cells to the column widths when the natural widths do not fit', () => {
    const rows = markdownRows('| name | note |\n|-|-|\n| x | alpha beta gamma |', 20);
    expect(texts(rows)).toEqual([
      '┌──────┬───────────┐',
      '│ name │ note      │',
      '├──────┼───────────┤',
      '│ x    │ alpha     │',
      '│      │ beta      │',
      '│      │ gamma     │',
      '└──────┴───────────┘',
    ]);
  });

  it('falls back to one "key: value" line per cell when the headers alone do not fit, with an empty row between records', () => {
    const rows = markdownRows('| name | note |\n|-|-|\n| x | alpha beta gamma |\n| y | z |', 12);
    expect(texts(rows)).toEqual(['name: x', 'note: alpha ', 'beta gamma', '', 'name: y', 'note: z']);
    expect(rows[0]?.spans).toEqual([[0, 4, 'bold']]);
  });

  it('keeps a line with bars that no delimiter row follows as text', () => {
    expect(texts(markdownRows('a | b\nc | d', 40))).toEqual(['a | b', 'c | d']);
  });
});

describe('markdown links', () => {
  const url = 'https://example.test/d';

  it('shows a markdown link as "text (url)" and links both, and links a bare URL without the full stop after it', () => {
    const rows = markdownRows(`see [docs](${url}) and https://b.test.`, 80);
    expect(texts(rows)).toEqual([`see docs (${url}) and https://b.test.`]);
    expect(rows[0]?.links).toEqual([[4, 8, url], [10, 32, url], [38, 52, 'https://b.test']]);
  });

  it('shows the URL once when the text is the URL, and links an autolink', () => {
    const rows = markdownRows(`[${url}](${url}) <${url}>`, 80);
    expect(texts(rows)).toEqual([`${url} ${url}`]);
    expect(rows[0]?.links).toEqual([[0, 22, url], [23, 45, url]]);
  });

  it('links nothing that is not http or https', () => {
    const rows = markdownRows('[x](javascript:alert) [y](file:///etc/passwd) [z](./local.md)', 80);
    expect(texts(rows)).toEqual(['x (javascript:alert) y (file:///etc/passwd) z (./local.md)']);
    expect(rows[0]?.links).toBeUndefined();
  });

  it('writes the OSC 8 sequence around the link text only, and the column of the text is the click target', () => {
    const [row] = markdownRows(`see [docs](${url})`, 80);
    if (row === undefined) throw new Error('no row');
    const pieces = piecesOf(row, undefined);
    expect(pieces.map((piece) => [piece.text, piece.url])).toEqual([['see ', undefined], ['docs', url], [' (', undefined], [url, url], [')', undefined]]);
    expect(hyperlink(url, 'docs')).toBe(`\u001b]8;;${url}\u0007docs\u001b]8;;\u0007`);
    const target = (column: number): string | undefined => {
      const range = indexRangeOf(row, column, column);
      return range === undefined ? undefined : row.links?.find(([start, end]) => start <= range[0] && range[0] < end)?.[2];
    };
    expect([3, 4, 7, 8, 10].map(target)).toEqual([undefined, url, url, undefined, url]);
  });

  it('carries a link on every row it spans', () => {
    const rows = markdownRows(`[alpha beta gamma](${url})`, 8);
    expect(texts(rows).slice(0, 3)).toEqual(['alpha ', 'beta ', 'gamma ']);
    expect(rows.slice(0, 3).map((row) => row.links)).toEqual([[[0, 6, url]], [[0, 5, url]], [[0, 5, url]]]);
  });
});

describe('streamed markdown', () => {
  const DOCUMENT = [
    '# Heading with `code`',
    '',
    'A paragraph with **strong** and *emphasis* and a [link](https://example.test/page) that is long enough to wrap.',
    'second line',
    '',
    '- item one',
    '- item **two**',
    '',
    '> quoted text',
    '',
    '```js',
    'const a = 1;',
    '',
    'const b = "**not bold**";',
    '```',
    '',
    '| name | value |',
    '|------|-------|',
    '| a    | 1     |',
    '| b    | 2     |',
    '',
    '---',
    '',
    '1. last',
    '   \t ',
    'tail `open',
  ].join('\n');

  it('gives the same rows for any way the answer is cut into deltas, at each width', () => {
    const random = seeded(7);
    for (const width of [12, 30, 80]) {
      const whole = createRowCache().rowsOf(storeOf([delta('a', DOCUMENT)]).at(0), width);
      for (let round = 0; round < 20; round += 1) {
        const pieces = createTranscriptStore();
        const cache = createRowCache();
        let from = 0;
        while (from < DOCUMENT.length) {
          const to = Math.min(DOCUMENT.length, from + 1 + Math.floor(random() * 25));
          foldEvent(pieces, eventOf(delta('a', DOCUMENT.slice(from, to))));
          cache.rowsOf(pieces.at(0), width);
          from = to;
        }
        expect(cache.rowsOf(pieces.at(0), width)).toEqual(whole);
      }
    }
  });

  it('gives through the cache the rows of the whole text rendered at once', () => {
    for (const width of [12, 30, 80]) expect(createRowCache().rowsOf(storeOf([delta('a', DOCUMENT)]).at(0), width)).toEqual(markdownRows(DOCUMENT, width));
  });

  it('renders only the segment that grew', () => {
    const store = storeOf([delta('a', '# One\n\n```\ncode\n\nmore\n```\n\ntail ')]);
    const calls: number[] = [];
    const cache = createRowCache({
      ...ROW_RENDERERS,
      answerRows: (text, from, width, reading) => {
        calls.push(text.length - from.characters);
        return ROW_RENDERERS.answerRows(text, from, width, reading);
      },
    });
    cache.rowsOf(store.at(0), 20);
    calls.length = 0;
    foldEvent(store, eventOf(delta('a', '**grows**')));
    expect(texts(cache.rowsOf(store.at(0), 20))).toEqual(['One', '', '  code', '  ', '  more', '', 'tail grows']);
    expect(calls).toEqual(['tail **grows**'.length]);
  });
});

describe('hostile answer text', () => {
  const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
  const PIECES = ['\u001b[31m', '\u001b]8;;http://evil.test\u0007', '\u0007', '\u009b2J', '‮', '\r', '\t', '\n', '\n\n', '```', '|', '-', '*', '_', '`', '[', ']', '(', ')', '<', '>', '#', ' ', 'http://a.test/', 'x', '漢', '👍', '\\', '1. ', '> '];

  it('never puts a control character into a row or a link target, and keeps every row within the width', () => {
    const random = seeded(23);
    for (let round = 0; round < 300; round += 1) {
      const text = Array.from({ length: Math.floor(random() * 80) }, () => PIECES[Math.floor(random() * PIECES.length)]).join('');
      const width = 8 + Math.floor(random() * 40);
      for (const row of assistantTextRows(text, width)) {
        expect(FORBIDDEN.test(row.text)).toBe(false);
        expect(displayWidth(row.text)).toBeLessThanOrEqual(width);
        for (const [start, end, target] of row.links ?? []) {
          expect(FORBIDDEN.test(target)).toBe(false);
          expect(target).toMatch(/^https?:\/\//);
          expect(start).toBeLessThan(end);
          expect(end).toBeLessThanOrEqual(row.text.length);
        }
        for (const [start, end] of row.spans) expect(start < end && end <= row.text.length).toBe(true);
      }
    }
  });

  it('shows an escape sequence inside a link and a code span as visible text', () => {
    const rows = assistantTextRows('[a\u0007b](http://b.test/\u0007x) `\u001b]0;t\u0007`', 80);
    expect(texts(rows)).toEqual(['a\\u0007b (http://b.test/\\u0007x) \\u001b]0;t\\u0007']);
    expect(rows[0]?.links).toEqual([[0, 8, 'http://b.test/\\u0007x'], [10, 31, 'http://b.test/\\u0007x']]);
  });

  it('wraps a line longer than one unit as plain text without reading its marks', () => {
    const line = '**a** '.repeat(Math.ceil(MARKDOWN_UNIT_BYTES / 6) + 1);
    const rows = markdownRows(line, 60);
    expect(rows.every((row) => row.spans.length === 0 && displayWidth(row.text) <= 60)).toBe(true);
    expect(logicalText(rows)).toBe(line);
  });

  it('finishes on deep nesting and on marks that never close', () => {
    for (const text of ['>'.repeat(5000), '*a _b '.repeat(2500), '['.repeat(8000), '`'.repeat(3) + ' `` '.repeat(3000), `${'| a '.repeat(2000)}|\n${'|-'.repeat(2000)}|\n${'| b '.repeat(2000)}|`]) {
      for (const row of markdownRows(text, 40)) expect(displayWidth(row.text)).toBeLessThanOrEqual(40);
    }
  });
});

describe('the other entries of the transcript', () => {
  it('echoes the user text behind "> " with its marks left as typed', () => {
    const rows = rowsOfEntry({ kind: 'user', text: '**hi** `there` friend' }, 12);
    expect(texts(rows)).toEqual(['> **hi** ', '  `there` ', '  friend']);
    expect(rows[0]?.spans).toEqual([[0, 9, 'user']]);
  });

  it('shows the plan as one line per item with its box', () => {
    const rows = rowsOfEntry({ kind: 'plan', entries: [{ content: 'read the code', priority: 'high', status: 'completed' }, { content: 'write the long test', priority: 'medium', status: 'in_progress' }, { content: 'ship **it**', priority: 'low', status: 'pending' }] }, 16);
    expect(texts(rows)).toEqual(['[x] read the ', 'code', '[~] write the ', 'long test', '[ ] ship **it**']);
  });

  it('shows a tool as its status mark and title, and a running tool with its whole elapsed seconds', () => {
    const tool = { kind: 'tool', callId: 'c', name: 'Read', title: 'Read /a/b.ts', toolKind: 'read', rawInput: {}, calledAt: 1000, shownAt: 3999 } as const;
    const marks = (['requested', 'awaiting_approval', 'running', 'completed', 'failed', 'unknown'] as const).map((status) => texts(rowsOfEntry({ ...tool, status }, 40)));
    expect(marks).toEqual([['· Read /a/b.ts'], ['! Read /a/b.ts'], ['⠹ Read /a/b.ts · 2s'], ['✓ Read /a/b.ts'], ['✗ Read /a/b.ts'], ['? Read /a/b.ts']]);
    expect(texts(rowsOfEntry({ ...tool, title: 'Read **/a**', status: 'completed' }, 8))).toEqual(['✓ Read ', '**/a**']);
  });
});
