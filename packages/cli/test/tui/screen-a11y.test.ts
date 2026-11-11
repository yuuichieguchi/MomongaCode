import { describe, expect, it } from 'vitest';
import { defaultTuiSettings } from '@momonga/config';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { A11Y_SETTINGS, a11yOf, NO_A11Y, NOTHING_ASKED, SCREEN_READER_KEEPS_HISTORY, STATIC_MARK, statusLine, statusLines } from '../../src/tui/screen/a11y.ts';
import type { A11y } from '../../src/tui/screen/a11y.ts';
import { rowsOfEntry } from '../../src/tui/screen/entry-rows.ts';
import { createRowCache, rowRenderersOf } from '../../src/tui/screen/row-cache.ts';
import { runningToolText } from '../../src/tui/screen/tool-view.ts';
import { SPINNER_FRAMES, waitingRowText } from '../../src/tui/screen/waiting-row.tsx';
import { moreRowText, selectedText } from '../../src/tui/select.tsx';
import { helpText } from '../../src/tui/slash.ts';
import type { Entry } from '../../src/tui/transcript.ts';
import { plainOf, storeOf, ROW_SCHEDULE } from './screen-fakes.ts';

const READER: A11y = { screenReader: true, reducedMotion: true };
const STILL: A11y = { screenReader: false, reducedMotion: true };

const rowsFor = (entry: Entry, a11y: A11y, width = 60): string[] => rowsOfEntry(entry, width, { keys: DEFAULT_KEY_TABLE, a11y }).map((row) => row.text);

const entryOf = (events: readonly Record<string, unknown>[], index = 0): Entry => {
  const entry = plainOf(storeOf(events)).entries[index];
  if (entry === undefined) throw new Error('no entry');
  return entry;
};

const call = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash: npm test', rawInput: { command: 'npm test' }, createdAt: 1000 };
const started = { type: 'tool.started', callId: 'c1', idemKey: 'k', createdAt: 1000 };
const completed = (output: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'tool.completed', callId: 'c1', status: 'completed', output, createdAt: 9000, ...extra });
const numbered = (count: number): string => Array.from({ length: count }, (_, index) => `out ${index}`).join('\n');

const GLYPHS = new RegExp(`[${SPINNER_FRAMES.join('')}]`);
const BOX = /[│─╭╮╰╯┌┐└┘├┤┬┴┼]/;

describe('the two accessibility switches', () => {
  it('are off unless a setting, the flag or the environment asks for them', () => {
    const stored = defaultTuiSettings();
    expect(a11yOf(stored, NOTHING_ASKED)).toEqual(NO_A11Y);
    expect(a11yOf({ ...stored, reducedMotion: true }, NOTHING_ASKED)).toEqual({ screenReader: false, reducedMotion: true });
    expect(a11yOf(stored, { screenReaderFlag: false, env: { NO_MOTION: '1' } })).toEqual({ screenReader: false, reducedMotion: true });
    expect(a11yOf(stored, { screenReaderFlag: false, env: { NO_MOTION: '0' } })).toEqual(NO_A11Y);
    expect(a11yOf(stored, { screenReaderFlag: false, env: { NO_MOTION: '' } })).toEqual(NO_A11Y);
  });

  it('the screen-reader display is asked for by its setting, --screen-reader or MOMONGA_SCREEN_READER=1, and implies reduced motion', () => {
    const stored = defaultTuiSettings();
    expect(a11yOf({ ...stored, screenReader: true }, NOTHING_ASKED)).toEqual(READER);
    expect(a11yOf(stored, { screenReaderFlag: true, env: {} })).toEqual(READER);
    expect(a11yOf(stored, { screenReaderFlag: false, env: { MOMONGA_SCREEN_READER: '1' } })).toEqual(READER);
    expect(a11yOf(stored, { screenReaderFlag: false, env: { MOMONGA_SCREEN_READER: 'yes' } })).toEqual(NO_A11Y);
  });

  it('have one row each for the settings command', () => {
    expect(A11Y_SETTINGS).toEqual([
      { name: 'screen-reader', setting: 'screenReader', label: 'Screen-reader display' },
      { name: 'reduced-motion', setting: 'reducedMotion', label: 'Reduced motion' },
    ]);
    expect(SCREEN_READER_KEEPS_HISTORY).toBe("Screen-reader mode keeps the terminal's own history.");
  });
});

describe('reduced motion', () => {
  it('replaces the spinner glyph of the waiting row by the static mark and keeps the seconds', () => {
    const waiting = { phase: { text: 'waiting for the model', startedAt: 0 }, cancelKey: 'run.stop' as const };
    expect(STATIC_MARK).toBe('•');
    expect(waitingRowText(waiting, { kind: 'static' }, 12_400, DEFAULT_KEY_TABLE)).toBe('• waiting for the model 12s · esc to cancel');
    expect(waitingRowText(waiting, { kind: 'spinner', tick: 1 }, 12_400, DEFAULT_KEY_TABLE)).toBe('⠙ waiting for the model 12s · esc to cancel');
  });

  it('replaces the spinner glyph of a running tool and keeps its seconds', () => {
    const running = entryOf([call, started]);
    if (running.kind !== 'tool') throw new Error('not a tool');
    expect(runningToolText({ ...running, shownAt: 13_000 }, STILL)).toBe('• Bash: npm test · 12s');
    expect(runningToolText({ ...running, shownAt: 13_000 }, NO_A11Y)).toMatch(new RegExp(`^[${SPINNER_FRAMES.join('')}] Bash: npm test · 12s$`));
    expect(rowsFor({ ...running, shownAt: 13_000 }, STILL)).toEqual(['• Bash: npm test · 12s']);
  });
});

describe('the screen-reader display of the transcript', () => {
  it('draws nothing for a tool that has not ended, and prints its line and the last 5 lines once it has', () => {
    for (const events of [[call], [call, started]]) expect(rowsFor(entryOf(events), READER)).toEqual([]);
    expect(rowsFor(entryOf([call, started, completed(numbered(30))]), READER)).toEqual(['✓ Bash: npm test', '  … +25 lines (ctrl+o to expand)', '  out 25', '  out 26', '  out 27', '  out 28', '  out 29']);
    expect(rowsFor(entryOf([call, started, { type: 'tool.completed', callId: 'c1', status: 'failed', output: 'boom', createdAt: 9000 }]), READER)).toEqual(['✗ Bash: npm test', '  boom']);
  });

  it('keeps the signs of a diff', () => {
    const edit = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Edit', kind: 'edit', title: 'Edit src/a.ts', rawInput: { file_path: 'src/a.ts', old_string: 'line10', new_string: 'changed10' }, createdAt: 1000 };
    const hunk = { oldStart: 9, newStart: 9, lines: [' line9', '-line10', '+changed10'] };
    expect(rowsFor(entryOf([edit, completed('Updated', { hunks: [hunk], added: 1, removed: 1 })]), READER)).toEqual(['✓ Edit src/a.ts', '• Edited src/a.ts (+1 -1)', '   9  line9', '  10 -line10', '  10 +changed10']);
  });

  it('draws nothing for a thought while it streams, and one line when it has ended', () => {
    const thinking = { type: 'agent.thought.delta', attempt: 0, itemId: 't1', text: 'first idea\nsecond idea', createdAt: 20_000 };
    expect(rowsFor(entryOf([thinking]), READER)).toEqual([]);
    expect(rowsFor(entryOf([thinking]), NO_A11Y)[0]).toBe('Thinking');
    const ended = entryOf([thinking, { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'answer', createdAt: 32_000 }]);
    expect(rowsFor(ended, READER)).toEqual(['Thought for 12s']);
  });

  it('writes a table as key: value lines with no box drawing', () => {
    const table = '| name | size |\n| --- | --- |\n| a.ts | 12 |\n| b.ts | 7 |';
    const reader = rowsFor({ kind: 'assistant', itemId: 'm1', text: table } as Entry, READER);
    expect(reader).toEqual(['name: a.ts', 'size: 12', '', 'name: b.ts', 'size: 7']);
    const drawn = rowsFor({ kind: 'assistant', itemId: 'm1', text: table } as Entry, NO_A11Y);
    expect(drawn.some((row) => BOX.test(row))).toBe(true);
    const stored = storeOf([{ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: table }]);
    const cached = createRowCache(rowRenderersOf({ keys: DEFAULT_KEY_TABLE, a11y: READER }), ROW_SCHEDULE).rowsOf(stored.at(0), 60);
    expect(cached.map((row) => row.text)).toEqual(reader);
  });

  it('writes the start banner as plain lines with its notices', () => {
    const banner = { config: { version: '1.2.3', home: '/home/u', color: true }, model: 'local', cwd: '/home/u/work', notices: ['an update is ready'] };
    const reader = rowsFor({ kind: 'banner', banner }, READER, 80);
    expect(reader).toEqual(['MomongaCode v1.2.3', 'model: local', '~/work', '! an update is ready']);
    expect(rowsFor({ kind: 'banner', banner }, NO_A11Y, 80).some((row) => BOX.test(row))).toBe(true);
  });

  it('never draws a spinner glyph or a box for any entry kind', () => {
    const entries: Entry[] = [
      entryOf([call, started]),
      entryOf([call, started, completed(numbered(9))]),
      entryOf([{ type: 'agent.thought.delta', attempt: 0, itemId: 't1', text: 'idea' }]),
      { kind: 'user', text: 'hello' },
      { kind: 'info', text: 'waiting for the model' },
      { kind: 'notice', level: 'warning', text: 'careful' },
      { kind: 'assistant', itemId: 'm1', text: '| a | b |\n| - | - |\n| 1 | 2 |' } as Entry,
    ];
    for (const entry of entries) for (const row of rowsFor(entry, READER)) expect(GLYPHS.test(row) || BOX.test(row), row).toBe(false);
  });

  it('names the highlighted row of a list in words and says where more rows are', () => {
    expect(selectedText('Yes, I trust this folder')).toBe('selected: Yes, I trust this folder');
    expect(moreRowText('up', 3, true)).toBe('3 more above');
    expect(moreRowText('down', 2, true)).toBe('2 more below');
    expect(moreRowText('down', 2, false)).toBe('  ↓ 2 more');
  });

  it('states mode, tokens and context as one line and as the Status group of /help', () => {
    const facts = { mode: 'auto', tokens: '1.2k', context: '12%' };
    expect(statusLine(facts)).toBe('mode: auto · tokens: 1.2k · context: 12%');
    expect(statusLines(facts)).toEqual(['mode: auto', 'tokens: 1.2k', 'context: 12%']);
    const lines = helpText({ commands: [], keys: DEFAULT_KEY_TABLE, negotiation: 'unknown', screen: 'scrollback', status: statusLines(facts) }).split('\n');
    expect(lines.slice(lines.indexOf('Status'))).toEqual(['Status', '  mode: auto', '  tokens: 1.2k', '  context: 12%']);
    expect(helpText({ commands: [], keys: DEFAULT_KEY_TABLE, negotiation: 'unknown', screen: 'scrollback' })).not.toContain('Status');
  });
});
