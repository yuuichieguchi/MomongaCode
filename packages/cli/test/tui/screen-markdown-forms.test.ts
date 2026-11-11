import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { markdownRows } from '../../src/tui/screen/markdown.ts';
import { createRowCache } from '../../src/tui/screen/row-cache.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { Row } from '../../src/tui/screen/wrap.ts';
import { foldEvent } from '../../src/tui/transcript.ts';
import { eventOf, manualSchedule, seeded, storeOf, ROW_RENDERERS } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const texts = (rows: readonly Row[]): string[] => rows.map((row) => row.text);
const spans = (rows: readonly Row[]): unknown[] => rows.map((row) => row.spans);
const delta = (itemId: string, text: string) => ({ type: 'agent.message.delta', attempt: 0, itemId, text });

describe('setext headings', () => {
  it('shows a line over a row of = or - as a heading, without the underline', () => {
    const rows = markdownRows('Title\n===\n\nSecond *part*\n---\nbody', 40);
    expect(texts(rows)).toEqual(['Title', '', 'Second part', 'body']);
    expect(spans(rows)).toEqual([[[0, 5, 'bold']], [], [[7, 11, 'italic'], [0, 11, 'bold']], []]);
  });

  it('makes every line of the paragraph over the underline a heading', () => {
    const rows = markdownRows('first line\nsecond line\n===', 40);
    expect(texts(rows)).toEqual(['first line', 'second line']);
    expect(spans(rows)).toEqual([[[0, 10, 'bold']], [[0, 11, 'bold']]]);
  });

  it('keeps a rule a rule after a blank line and after a list item, and an underline with nothing over it literal', () => {
    expect(texts(markdownRows('text\n\n---', 10))).toEqual(['text', '', '─'.repeat(10)]);
    expect(texts(markdownRows('- item\n---', 10))).toEqual(['• item', '─'.repeat(10)]);
    expect(texts(markdownRows('===\ntext', 10))).toEqual(['===', 'text']);
  });
});

describe('indented code', () => {
  it('shows lines indented four columns after a blank line as a code block', () => {
    const rows = markdownRows('text\n\n    const a = **1**;\n      deeper\n\nafter', 40);
    expect(texts(rows)).toEqual(['text', '', '  const a = **1**;', '    deeper', '', 'after']);
    expect(spans(rows)).toEqual([[], [], [[2, 18, 'code']], [[2, 10, 'code']], [], []]);
  });

  it('does not let an indented line interrupt a paragraph or a list item, and reads a list item by its own indent', () => {
    expect(spans(markdownRows('text\n    still text', 40))).toEqual([[], []]);
    expect(texts(markdownRows('- item\n\n    more of the item\n\n      code of the item', 40))).toEqual(['• item', '', '    more of the item', '', '  code of the item']);
    expect(texts(markdownRows('- one\n    - nested', 40))).toEqual(['• one', '    • nested']);
  });
});

describe('reference links', () => {
  it('shows a reference as its text and the address of its definition, and hides the definition', () => {
    const rows = markdownRows('see [the docs][d], [d] and [D][]\n\n[d]: https://example.test/docs "Docs"', 200);
    expect(texts(rows)).toEqual(['see the docs (https://example.test/docs), d (https://example.test/docs) and D (https://example.test/docs)', '']);
    expect(rows[0]?.links?.map((link) => link[2])).toEqual(Array.from({ length: 6 }, () => 'https://example.test/docs'));
  });

  it('leaves a reference with no definition, and a definition inside a code block, as they are written', () => {
    expect(texts(markdownRows('[a][b] and [c]', 40))).toEqual(['[a][b] and [c]']);
    expect(texts(markdownRows('[a][b]\n\n```\n[b]: https://x.test\n```', 40))).toEqual(['[a][b]', '', '  [b]: https://x.test']);
  });

  it('links only a definition with an http or https address', () => {
    const [row] = markdownRows('[a][b]\n[b]: javascript:alert(1)', 40);
    expect(row?.text).toBe('a (javascript:alert(1))');
    expect(row?.links).toBeUndefined();
  });

  it('renders the references of an answer whose definition arrives after the text that uses it, for any cut into deltas', () => {
    const answer = 'Intro with [one][1] and [two][2].\n\n```\n[3]: https://not.test\n```\n\nMore [one][1] and [three][3].\n\n[1]: https://one.test\n[2]: https://two.test\n\ntail';
    const whole = markdownRows(answer, 30);
    expect(texts(whole).join(' ')).toContain('one (https://one.test)');
    expect(texts(whole).join(' ')).toContain('[three][3]');
    const random = seeded(19);
    for (let round = 0; round < 30; round += 1) {
      const pieces = createTranscriptStore();
      const cache = createRowCache(ROW_RENDERERS, manualSchedule().schedule);
      for (let from = 0; from < answer.length; ) {
        const to = Math.min(answer.length, from + 1 + Math.floor(random() * 20));
        foldEvent(pieces, eventOf(delta('a', answer.slice(from, to))));
        cache.rowsOf(pieces.at(0), 30);
        from = to;
      }
      expect(cache.rowsOf(pieces.at(0), 30)).toEqual(whole);
    }
  });

  it('does not parse an open answer again for a line that is no definition', () => {
    const store = storeOf([delta('a', 'first [x][1]\n\n[1]: https://one.test\n\nsecond ')]);
    const calls: number[] = [];
    const cache = createRowCache(
      {
        ...ROW_RENDERERS,
        answerRows: (text, from, width, reading) => {
          calls.push(text.length - from.characters);
          return ROW_RENDERERS.answerRows(text, from, width, reading);
        },
      },
      manualSchedule().schedule,
    );
    cache.rowsOf(store.at(0), 40);
    calls.length = 0;
    foldEvent(store, eventOf(delta('a', 'line\n\nthird')));
    cache.rowsOf(store.at(0), 40);
    expect(calls).toEqual(['second line\n\nthird'.length]);
  });
});

describe('images, strikethrough and raw HTML', () => {
  it('shows an image as its alt text and its address', () => {
    const rows = markdownRows('![a diagram](https://example.test/d.png) and ![logo][l]\n\n[l]: https://example.test/logo.png', 80);
    expect(texts(rows)).toEqual(['a diagram (https://example.test/d.png) and logo (https://example.test/logo.png)', '']);
    expect(texts(markdownRows('wow! [not an image] and ![broken](', 80))).toEqual(['wow! [not an image] and ![broken](']);
  });

  it('leaves strikethrough marks and raw HTML as text', () => {
    expect(texts(markdownRows('~~gone~~ <b>bold</b> <div class="x">', 80))).toEqual(['~~gone~~ <b>bold</b> <div class="x">']);
    expect(texts(markdownRows('<details>\n<summary>more</summary>\n</details>', 80))).toEqual(['<details>', '<summary>more</summary>', '</details>']);
  });
});
