import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_MAX_BYTES, markdownRows } from '../../src/tui/screen/markdown.ts';
import { HIGHLIGHTED_LANGUAGES } from '../../src/tui/screen/highlight.ts';
import { createRowCache } from '../../src/tui/screen/row-cache.ts';
import { piecesOf } from '../../src/tui/screen/row-text.tsx';
import { styleOf } from '../../src/tui/screen/theme.ts';
import type { Appearance } from '../../src/tui/screen/theme.ts';
import type { Row, Span } from '../../src/tui/screen/wrap.ts';
import { foldEvent } from '../../src/tui/transcript.ts';
import { eventOf, manualSchedule, storeOf, ROW_RENDERERS } from './screen-fakes.ts';

const delta = (itemId: string, text: string) => ({ type: 'agent.message.delta', attempt: 0, itemId, text });
const texts = (rows: readonly Row[]): string[] => rows.map((row) => row.text);
const tokensAt = (row: Row | undefined, word: string): string[] => {
  const at = row?.text.indexOf(word) ?? -1;
  return at < 0 || row === undefined ? [] : row.spans.filter(([start, end]) => start <= at && at < end).map((span) => span[2]);
};
const covers = (row: Row, prefix: number): boolean => {
  const edges = [...row.spans].sort((left, right) => left[0] - right[0]);
  let reached = prefix;
  for (const [start, end] of edges) {
    if (start > reached) return false;
    reached = Math.max(reached, end);
  }
  return reached === row.text.length;
};

describe('syntax colour in a fenced code block', () => {
  it('colours the keywords, strings, numbers and comments of a ts block with theme tokens', () => {
    const rows = markdownRows('```ts\nconst name: string = "momonga"; // the name\nreturn 42;\n```', 80);
    expect(texts(rows)).toEqual(['  ts', '  const name: string = "momonga"; // the name', '  return 42;']);
    const [, first, second] = rows;
    expect(tokensAt(first, 'const')).toEqual(['accent']);
    expect(tokensAt(first, '"momonga"')).toEqual(['success']);
    expect(tokensAt(first, '// the name')).toEqual(['dim', 'italic']);
    expect(tokensAt(second, 'return')).toEqual(['accent']);
    expect(tokensAt(second, '42')).toEqual(['warning']);
    expect(tokensAt(first, 'name')).toEqual(['code']);
  });

  it('covers every column of a highlighted line after the indent with a token, and none of the indent', () => {
    const rows = markdownRows('```python\ndef greet(who):\n    return f"hi {who}"  # say it\n```', 24);
    for (const row of rows.slice(1)) {
      expect(row.spans.every(([start]) => start >= 2)).toBe(true);
      expect(covers(row, 2)).toBe(true);
    }
  });

  it('reads a block as one text: the middle line of a comment of three lines is a comment', () => {
    const rows = markdownRows('```js\n/* first\n   middle words\n   last */\nlet x = 1;\n```', 80);
    expect(tokensAt(rows[2], 'middle')).toEqual(['dim', 'italic']);
    expect(tokensAt(rows[4], 'let')).toEqual(['accent']);
  });

  it('knows the languages of a coding agent by their common names', () => {
    for (const name of ['ts', 'typescript', 'js', 'py', 'sh', 'bash', 'json', 'go', 'rust', 'yaml', 'yml', 'html', 'diff', 'sql']) expect(HIGHLIGHTED_LANGUAGES.has(name)).toBe(true);
    const rows = markdownRows('```diff\n+added\n-removed\n```', 40);
    expect(tokensAt(rows[1], 'added')).toEqual(['diff.added']);
    expect(tokensAt(rows[2], 'removed')).toEqual(['diff.removed']);
  });

  it('draws a block of an unknown language and a block with no language in the code token', () => {
    for (const fence of ['```klingon', '```']) {
      const rows = markdownRows(`${fence}\nconst a = "b";\n\`\`\``, 40);
      expect(rows.at(-1)?.spans).toEqual([[2, 16, 'code']]);
    }
  });

  it('draws a block larger than the bound in the code token', () => {
    const line = 'const value = "a string";';
    const body = Array.from({ length: Math.ceil((HIGHLIGHT_MAX_BYTES + 1024) / (line.length + 1)) }, () => line).join('\n');
    expect(Buffer.byteLength(body)).toBeGreaterThan(HIGHLIGHT_MAX_BYTES);
    const rows = markdownRows(`\`\`\`ts\n${body}\n\`\`\``, 80);
    expect(rows.slice(1).every((row) => row.spans.length === 1 && row.spans[0]?.[2] === 'code')).toBe(true);
    const small = markdownRows(`\`\`\`ts\n${line}\n\`\`\``, 80);
    expect(tokensAt(small[1], 'const')).toEqual(['accent']);
  });

  it('keeps an escape sequence in code visible text and lays the colour over that text', () => {
    const rows = markdownRows('```js\nconst s = "\u001b[31mred";\n```', 80);
    expect(rows[1]?.text).toBe('  const s = "\\u001b[31mred";');
    expect(tokensAt(rows[1], '"\\u001b[31mred"')).toEqual(['success']);
    for (const [start, end] of rows[1]?.spans ?? []) expect(start < end && end <= (rows[1]?.text.length ?? 0)).toBe(true);
  });

  it('gives a highlighted row no colour and its attributes under NO_COLOR', () => {
    const noColour: Appearance = { noColor: true, level: 3, background: 'dark' };
    const [, row] = markdownRows('```ts\n// note\n```', 40);
    const styles = row === undefined ? [] : piecesOf(row, undefined).map((piece) => piece.style);
    expect(styles.some((style) => style.italic === true)).toBe(true);
    const tokens = (row?.spans ?? []).map((span: Span) => span[2]);
    expect(styleOf(tokens, noColour, 'dark').color).toBeUndefined();
  });
});

describe('a code block of an open answer', () => {
  it('draws its lines in the code token while it is open and colours the block when its fence closes', () => {
    const store = storeOf([delta('a', 'Intro\n\n```ts\nconst a = 1;\n')]);
    const cache = createRowCache(ROW_RENDERERS, manualSchedule().schedule);
    expect(cache.rowsOf(store.at(0), 40)[3]?.spans).toEqual([[2, 14, 'code']]);
    foldEvent(store, eventOf(delta('a', '```\n\nafter')));
    const rows = cache.rowsOf(store.at(0), 40);
    expect(texts(rows)).toEqual(['Intro', '', '  ts', '  const a = 1;', '', 'after']);
    expect(tokensAt(rows[3], 'const')).toEqual(['accent']);
    expect(rows).toEqual(markdownRows('Intro\n\n```ts\nconst a = 1;\n```\n\nafter', 40));
  });

  it('colours a block that is closed by the end of a settled answer', () => {
    const rows = markdownRows('```ts\nconst a = 1;', 40);
    expect(tokensAt(rows[1], 'const')).toEqual(['accent']);
  });
});
