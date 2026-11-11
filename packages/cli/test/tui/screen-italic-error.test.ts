import { describe, expect, it } from 'vitest';
import { describeFailure } from '../../src/failure.ts';
import { parseRecord } from '../../src/handover/record.ts';
import { entryOfNote, isLocalNote } from '../../src/tui/handover.ts';
import { rowsOfEntry } from '../../src/tui/screen/entry-rows.ts';
import { markdownRows } from '../../src/tui/screen/markdown.ts';
import { piecesOf } from '../../src/tui/screen/row-text.tsx';
import { STYLE, styleOf } from '../../src/tui/screen/theme.ts';
import type { Appearance } from '../../src/tui/screen/theme.ts';
import { thoughtRows } from '../../src/tui/screen/thought.ts';
import type { Row } from '../../src/tui/screen/wrap.ts';
import type { Entry } from '../../src/tui/transcript.ts';
import { ROW_FACTS } from './screen-fakes.ts';

const tokensOf = (row: Row): string[] => row.spans.map((span) => span[2]);
const COLOURED: Appearance = { noColor: false, level: 3, background: 'dark' };
const NO_COLOUR: Appearance = { noColor: true, level: 3, background: 'dark' };

describe('the italic token', () => {
  it('is italic and nothing else, and stays italic when colour is refused', () => {
    expect(STYLE.italic).toEqual({ attrs: { italic: true } });
    expect(styleOf(['italic'], COLOURED, 'dark')).toEqual({ italic: true });
    expect(styleOf(['italic'], NO_COLOUR, 'dark')).toEqual({ italic: true });
    expect(styleOf(['dim', 'italic'], NO_COLOUR, 'dark')).toEqual({ dimColor: true, italic: true });
  });

  it('styles emphasis, and strong emphasis stays bold', () => {
    const [row] = markdownRows('a *b* _c_ **d** ***e***', 40);
    expect(row?.text).toBe('a b c d e');
    expect(row?.spans).toEqual([[2, 3, 'italic'], [4, 5, 'italic'], [6, 7, 'bold'], [8, 9, 'italic'], [8, 9, 'bold']]);
  });

  it('reaches the drawn piece of a row', () => {
    const [row] = markdownRows('*b*', 40);
    expect(row === undefined ? [] : piecesOf(row, undefined).map((piece) => piece.style)).toEqual([{ italic: true }]);
  });
});

describe('a thought', () => {
  const thought = (fields: { endedAt?: number; expanded: boolean }): Extract<Entry, { kind: 'thought' }> => ({ kind: 'thought', itemId: 't', text: 'why this is so\nbecause', startedAt: 0, window: 5, ...fields });

  it('shows the text of an open thought dim and italic under a dim header', () => {
    const rows = thoughtRows(thought({ expanded: false }), 40);
    expect(rows.map((row) => row.text)).toEqual(['Thinking', 'why this is so', 'because']);
    expect(rows.map(tokensOf)).toEqual([['dim'], ['dim', 'italic'], ['dim', 'italic']]);
  });

  it('shows the text of an expanded thought dim and italic', () => {
    const rows = thoughtRows(thought({ endedAt: 2000, expanded: true }), 40);
    expect(rows.map(tokensOf)).toEqual([['dim'], ['dim', 'italic'], ['dim', 'italic']]);
  });
});

describe('an error entry', () => {
  const failure = Object.assign(new Error('the gateway refused the request'), { detail: 'status 401 from the model server', remediation: 'Sign in with /login.' });

  it('shows the lines the headless path prints: the first in the error token, the detail dim, the remedy in the accent token', () => {
    const text = describeFailure(failure);
    const rows = rowsOfEntry({ kind: 'error', text }, 80, ROW_FACTS);
    expect(rows.map((row) => row.text).join('\n')).toBe(text);
    expect(rows.map((row) => row.text)).toEqual(['the gateway refused the request', '  detail: status 401 from the model server', '  remedy: Sign in with /login.']);
    expect(rows.map(tokensOf)).toEqual([['error'], ['dim'], ['accent']]);
  });

  it('keeps the style of a line on the rows it wraps to, and shows a failure of one line in the error token', () => {
    const rows = rowsOfEntry({ kind: 'error', text: describeFailure(failure) }, 24, ROW_FACTS);
    expect(rows.filter((row) => row.text.includes('Sign in') || row.text.includes('/login')).every((row) => tokensOf(row).join() === 'accent')).toBe(true);
    expect(rowsOfEntry({ kind: 'error', text: describeFailure(new Error('boom')) }, 80, ROW_FACTS).map(tokensOf)).toEqual([['error']]);
  });

  it('is a local note that a handover carries and gives back as an error entry', () => {
    const entry: Entry = { kind: 'error', text: 'boom\n  remedy: try again' };
    expect(isLocalNote(entry)).toBe(true);
    expect(entryOfNote({ anchor: null, kind: 'error', level: 'error', text: entry.text })).toEqual(entry);
    const record = {
      format: 'handover/1',
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
      session: 's',
      lastSeq: {},
      kind: 'tui',
      neg: 'kitty',
      hint: 'shift+enter',
      size: { columns: 120, rows: 40 },
      input: { text: '', cursor: 0, historyIndex: null },
      attachments: [],
      notes: [{ anchor: null, kind: 'error', level: 'error', text: entry.text }],
    };
    const parsed = parseRecord(JSON.stringify(record));
    expect(parsed.kind === 'record' && parsed.record.kind === 'tui' ? parsed.record.notes : parsed).toEqual(record.notes);
  });
});
