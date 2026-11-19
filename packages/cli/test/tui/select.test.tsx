import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import { choiceLines, joinHint, selectClick, selectHint, selectKey, selectLayout, selectRowAt, selectStart, selectText, selectWheel, SelectView } from '../../src/tui/select.tsx';
import type { SelectOutcome, SelectSpec, SelectState } from '../../src/tui/select.tsx';
import { renderObservable } from '../ink-helpers.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { keyEventOf } from './screen-fakes.ts';

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

const labels = (count: number): { label: string }[] => Array.from({ length: count }, (_, index) => ({ label: `row ${index + 1}` }));

const spec = (given: Partial<SelectSpec> = {}): SelectSpec => ({ rows: labels(4), initial: 0, decideOn: 'immediate', escape: 'back', interrupt: 'back', filter: false, ...given });

const PAGE = 3;

const press = (of: SelectSpec, state: SelectState, input: string, key: Partial<Key> = {}): { state: SelectState; outcome?: SelectOutcome } => selectKey(of, state, keyEventOf(input, { ...NO_KEY, ...key }), DEFAULT_KEY_TABLE, PAGE);

const after = (of: SelectSpec, keys: readonly (readonly [string, Partial<Key>?])[]): { state: SelectState; outcomes: SelectOutcome[] } => {
  let state = selectStart(of);
  const outcomes: SelectOutcome[] = [];
  for (const [input, key] of keys) {
    const result = press(of, state, input, key);
    state = result.state;
    if (result.outcome !== undefined) outcomes.push(result.outcome);
  }
  return { state, outcomes };
};

const MODES = ['enter', 'immediate'] as const;

describe('the keys of the one selection component', () => {
  it.each(MODES)('moves with up, down, ctrl+p, ctrl+n and wraps, and never decides by moving (%s)', (decideOn) => {
    const of = spec({ decideOn });
    expect(after(of, [['', { upArrow: true }]])).toMatchObject({ state: { index: 3 }, outcomes: [] });
    expect(after(of, [['', { downArrow: true }], ['', { downArrow: true }]])).toMatchObject({ state: { index: 2 }, outcomes: [] });
    expect(after(of, [['p', { ctrl: true }]])).toMatchObject({ state: { index: 3 }, outcomes: [] });
    expect(after(of, [['n', { ctrl: true }], ['n', { ctrl: true }], ['n', { ctrl: true }], ['n', { ctrl: true }]])).toMatchObject({ state: { index: 0 }, outcomes: [] });
  });

  it.each(MODES)('moves with j and k only when typing does not filter (%s)', (decideOn) => {
    expect(after(spec({ decideOn }), [['j'], ['j'], ['k']])).toMatchObject({ state: { index: 1 }, outcomes: [] });
    expect(after(spec({ decideOn, filter: true }), [['j']])).toMatchObject({ state: { index: 0, filter: 'j' }, outcomes: [] });
  });

  it.each(MODES)('moves by a page, to the first and to the last row (%s)', (decideOn) => {
    const of = spec({ decideOn, rows: labels(10) });
    expect(after(of, [['', { pageDown: true }]]).state.index).toBe(3);
    expect(after(of, [['', { end: true }]]).state.index).toBe(9);
    expect(after(of, [['', { end: true }], ['', { pageUp: true }]]).state.index).toBe(6);
    expect(after(of, [['', { pageDown: true }], ['', { home: true }]]).state.index).toBe(0);
    expect(after(of, [['', { end: true }], ['', { pageDown: true }]])).toMatchObject({ state: { index: 9 }, outcomes: [] });
  });

  it('a digit moves to its row when only enter decides and decides its row when the prompt decides at once', () => {
    expect(after(spec({ decideOn: 'enter' }), [['3']])).toMatchObject({ state: { index: 2 }, outcomes: [] });
    expect(after(spec({ decideOn: 'immediate' }), [['3']]).outcomes).toEqual([{ kind: 'decide', index: 2 }]);
    expect(after(spec({ decideOn: 'immediate' }), [['9']]).outcomes).toEqual([]);
  });

  it.each(MODES)('a digit is text of the filter when typing filters (%s)', (decideOn) => {
    const of = spec({ decideOn, filter: true, rows: labels(12) });
    expect(after(of, [['1'], ['2']])).toMatchObject({ state: { filter: '12', index: 11 }, outcomes: [] });
  });

  it.each(MODES)('enter decides the highlighted row (%s)', (decideOn) => {
    expect(after(spec({ decideOn }), [['', { downArrow: true }], ['', { return: true }]]).outcomes).toEqual([{ kind: 'decide', index: 1 }]);
  });

  it.each(MODES)('escape decides the escape row, backs out, or does nothing, and first clears a filter (%s)', (decideOn) => {
    expect(after(spec({ decideOn, escape: 1 }), [['', { escape: true }]]).outcomes).toEqual([{ kind: 'decide', index: 1 }]);
    expect(after(spec({ decideOn, escape: 'back' }), [['', { escape: true }]]).outcomes).toEqual([{ kind: 'back' }]);
    expect(after(spec({ decideOn, escape: 'inactive' }), [['', { escape: true }]]).outcomes).toEqual([]);
    const filtered = after(spec({ decideOn, filter: true }), [['3'], ['', { escape: true }]]);
    expect(filtered).toMatchObject({ state: { filter: '' }, outcomes: [] });
    expect(press(spec({ decideOn, filter: true }), filtered.state, '', { escape: true }).outcome).toEqual({ kind: 'back' });
  });

  it.each(MODES)('ctrl+c is the interrupt of the instance (%s)', (decideOn) => {
    for (const interrupt of ['exit', 'cancel-run', 'back'] as const) expect(after(spec({ decideOn, interrupt }), [['c', { ctrl: true }]]).outcomes).toEqual([{ kind: 'interrupt', action: interrupt }]);
  });

  it.each(MODES)('typing and backspace edit the filter and the highlight goes to the first match (%s)', (decideOn) => {
    const of = spec({ decideOn, filter: true, rows: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }, { label: 'Betamax' }] });
    const typed = after(of, [['b'], ['e']]);
    expect(typed).toMatchObject({ state: { filter: 'be', index: 1 }, outcomes: [] });
    expect(press(of, typed.state, '', { downArrow: true }).state.index).toBe(3);
    expect(press(of, typed.state, '', { backspace: true }).state).toMatchObject({ filter: 'b', index: 1 });
    expect(after(of, [['g'], ['', { return: true }]]).outcomes).toEqual([{ kind: 'decide', index: 2 }]);
    expect(after(of, [['z'], ['', { return: true }]]).outcomes).toEqual([]);
  });

  it('a press on a row moves to it when only enter decides and decides it when the prompt decides at once', () => {
    const entered = spec({ decideOn: 'enter' });
    expect(selectClick(entered, selectStart(entered), 2)).toMatchObject({ state: { index: 2 } });
    expect(selectClick(entered, selectStart(entered), 2).outcome).toBeUndefined();
    const immediate = spec({ decideOn: 'immediate' });
    expect(selectClick(immediate, selectStart(immediate), 2).outcome).toEqual({ kind: 'decide', index: 2 });
  });

  it('a disabled row and a separator are never decided, and a separator is never highlighted', () => {
    const of = spec({ rows: [{ label: 'a' }, { label: 'found by search', separator: true }, { label: 'b', disabled: true }, { label: 'c' }] });
    expect(after(of, [['', { downArrow: true }]]).state.index).toBe(2);
    expect(after(of, [['', { downArrow: true }], ['', { return: true }]]).outcomes).toEqual([]);
    expect(after(of, [['2']])).toMatchObject({ state: { index: 2 }, outcomes: [] });
    expect(after(of, [['3']]).outcomes).toEqual([{ kind: 'decide', index: 3 }]);
    expect(selectClick(of, selectStart(of), 1)).toEqual({ state: selectStart(of) });
    expect(selectClick(of, selectStart(of), 2).outcome).toBeUndefined();
  });

  it('a row that needs a second enter is decided by the second one and a move withdraws the first', () => {
    const of = spec({ confirm: (row) => `press enter again to sign out ${row.label}` });
    expect(after(of, [['', { return: true }]])).toMatchObject({ state: { confirming: 0 }, outcomes: [] });
    expect(after(of, [['', { return: true }], ['', { return: true }]]).outcomes).toEqual([{ kind: 'decide', index: 0 }]);
    expect(after(of, [['', { return: true }], ['', { downArrow: true }], ['', { return: true }]])).toMatchObject({ state: { confirming: 1 }, outcomes: [] });
  });

  it('the second deciding key chooses the highlighted row with its own outcome, only where the instance has one', () => {
    expect(after(spec({ alt: { label: 'use from now on' } }), [['', { downArrow: true }], ['', { tab: true }]]).outcomes).toEqual([{ kind: 'alt', index: 1 }]);
    expect(after(spec(), [['', { tab: true }]]).outcomes).toEqual([]);
  });

  it('starts on the initial row', () => {
    expect(selectStart(spec({ initial: 1 })).index).toBe(1);
  });
});

describe('the hint line is generated from the props', () => {
  it('names only the keys that act', () => {
    const rows = [{ label: 'Yes' }, { label: 'No, not now' }];
    expect(selectHint(spec({ rows, decideOn: 'enter', escape: 1, interrupt: 'exit' }), DEFAULT_KEY_TABLE)).toBe('up/down to move · enter to choose · esc: No, not now');
    expect(selectHint(spec({ rows, decideOn: 'immediate', escape: 1, interrupt: 'cancel-run' }), DEFAULT_KEY_TABLE)).toBe('1-9 or enter to choose · up/down to move · esc: No, not now · ctrl+c: cancel the run');
    expect(selectHint(spec({ rows, decideOn: 'immediate', escape: 'inactive', interrupt: 'cancel-run' }), DEFAULT_KEY_TABLE)).toBe('1-9 or enter to choose · up/down to move · ctrl+c: cancel the run');
    expect(selectHint(spec({ rows, decideOn: 'immediate', escape: 'back' }), DEFAULT_KEY_TABLE)).toBe('1-9 or enter to choose · up/down to move · esc: go back');
    expect(selectHint(spec({ rows, decideOn: 'immediate', escape: 'back', filter: true }), DEFAULT_KEY_TABLE)).toBe('enter to choose · up/down to move · type to filter · esc: go back');
    expect(selectHint(spec({ rows, alt: { label: 'use from now on' } }), DEFAULT_KEY_TABLE)).toBe('1-9 or enter to choose · up/down to move · tab: use from now on · esc: go back');
    expect(joinHint(['enter to confirm', 'esc: go back'])).toBe('enter to confirm · esc: go back');
  });
});

describe('the list in the rows it is given', () => {
  const frame = { width: 40, rows: 9, border: true };

  it('shows a window with the rows left above and below, keeps the highlight in it and maps a screen row to its choice', () => {
    const of = spec({ title: 'Pick', rows: labels(12) });
    const text = selectText(of, frame);
    const top = selectLayout(of, selectStart(of), text, frame, 0, false);
    expect(top.items).toEqual([0, 1, 2, 3]);
    expect([top.above, top.below]).toEqual([0, 8]);
    expect(top.listTop).toBe(2);
    expect(selectRowAt(top, 2)).toBe(0);
    expect(selectRowAt(top, 5)).toBe(3);
    expect(selectRowAt(top, 6)).toBeUndefined();
    expect(selectRowAt(top, 1)).toBeUndefined();
    const moved = after(of, [['', { end: true }]]).state;
    const end = selectLayout(of, moved, text, frame, 0, false);
    expect(end.items).toEqual([8, 9, 10, 11]);
    expect([end.above, end.below]).toEqual([8, 0]);
    const wider = selectLayout(of, moved, text, { ...frame, rows: 30 }, 0, false);
    expect(wider.items).toHaveLength(12);
    expect(moved.index).toBe(11);
  });

  it('the wheel scrolls the list and leaves the highlight where it is', () => {
    const of = spec({ title: 'Pick', rows: labels(12) });
    const text = selectText(of, frame);
    const scrolled = selectWheel(of, selectStart(of), 3, selectLayout(of, selectStart(of), text, frame, 0, false).capacity);
    expect(scrolled.index).toBe(0);
    expect(selectLayout(of, scrolled, text, frame, 0, false).items).toEqual([3, 4, 5]);
  });

  it('keeps the approval title in a short frame: the frame bound wins over the list floor', () => {
    const title = 'Permission requested: Write a.txt';
    const of = spec({ title, lines: Array.from({ length: 20 }, (_, index) => `line ${index}`), rows: labels(3) });
    const short = { width: 60, rows: 8, border: true };
    const layout = selectLayout(of, selectStart(of), selectText(of, short), short, 1, false);
    expect(layout.text[0]?.text).toBe(title);
    expect(layout.text.length + layout.items.length + (layout.moreRow ? 1 : 0)).toBeLessThanOrEqual(4);
  });

  it('never hides text without saying so: the last text row counts the rows that did not fit', () => {
    const of = spec({ title: 'Permission requested: Write a.txt', lines: Array.from({ length: 20 }, (_, index) => `line ${index}`), rows: labels(2) });
    const layout = selectLayout(of, selectStart(of), selectText(of, frame), frame, 0, false);
    expect(layout.text.map((row) => row.text)).toEqual(['Permission requested: Write a.txt', 'line 0', 'line 1']);
    expect(layout.more).toBe(18);
    expect(layout.items).toEqual([0, 1]);
  });
});

describe('the rows a list panel draws are the rows it was given (cli-tui-23)', () => {
  const drawnRows = (of: SelectSpec, frame: { width: number; rows: number; border: boolean }): string[] => {
    const state = selectStart(of);
    const app = renderObservable(<SelectView spec={of} layout={selectLayout(of, state, selectText(of, frame), frame, 0, false)} state={state} border={frame.border} keys={DEFAULT_KEY_TABLE} sending={false} settling={false} />);
    const shown = (app.lastFrame() ?? '').split('\n');
    app.unmount();
    return shown;
  };

  const SMALLEST_BORDERED_ROWS = 6;

  it('never draws more rows than its frame holds, whatever the text and the list', () => {
    for (const rows of [SMALLEST_BORDERED_ROWS, 7, 10]) {
      for (const lines of [0, 4]) {
        for (const choices of [2, 5]) {
          const of = spec({ title: 'Permission requested: Bash ls', lines: Array.from({ length: lines }, (_, index) => `line ${index}`), rows: labels(choices) });
          const shown = drawnRows(of, { width: 60, rows, border: true });
          expect(shown.length, `${rows} rows, ${lines} lines, ${choices} choices:\n${shown.join('\n')}`).toBeLessThanOrEqual(rows);
          expect(shown.at(-1)).toMatch(/^╰/);
        }
      }
    }
  });

  it('counts the row that says text was cut, and where the text has no row of its own the last row says it', () => {
    const of = spec({ title: 'Permission requested: Bash ls', lines: ['the reason'], rows: labels(4) });
    const long = spec({ ...of, lines: ['a', 'b', 'c'] });
    const wider = { width: 60, rows: 8, border: true };
    const roomy = selectLayout(long, selectStart(long), selectText(long, wider), wider, 0, false);
    expect([roomy.text.length, roomy.more, roomy.moreRow, roomy.listTop]).toEqual([1, 3, true, 3]);
    const tight = { width: 60, rows: SMALLEST_BORDERED_ROWS, border: true };
    const layout = selectLayout(of, selectStart(of), selectText(of, tight), tight, 0, false);
    expect([layout.text.length, layout.more, layout.moreRow, layout.listTop]).toEqual([0, 2, false, 1]);
    const shown = drawnRows(of, tight);
    expect(shown).toHaveLength(SMALLEST_BORDERED_ROWS);
    expect(shown[1]).toContain('› 1. row 1');
    expect(shown[4]).toContain('… 2 more lines (ctrl+o shows all)');
  });
});

describe('a row that opens a browser or starts a sign-in', () => {
  const of = spec({ rows: [{ label: 'a' }, { label: 'Continue in the browser', opensBrowser: true }, { label: 'c' }] });

  it('is only highlighted by its digit, and enter or a click decides it', () => {
    const digit = press(of, selectStart(of), '2');
    expect(digit.outcome).toBeUndefined();
    expect(digit.state.index).toBe(1);
    expect(press(of, digit.state, '', { return: true }).outcome).toEqual({ kind: 'decide', index: 1 });
    expect(selectClick(of, selectStart(of), 1).outcome).toEqual({ kind: 'decide', index: 1 });
  });

  it('leaves the other rows of the list decided by their digit', () => {
    expect(press(of, selectStart(of), '3').outcome).toEqual({ kind: 'decide', index: 2 });
  });

  it('is decided by its digit in a list whose enter is off', () => {
    expect(press({ ...of, enterOff: true }, selectStart(of), '2').outcome).toEqual({ kind: 'decide', index: 1 });
  });
});

describe('the rows as drawn', () => {
  const drawn = (of: SelectSpec, state: SelectState, extra: { sending?: boolean; error?: string } = {}): string => {
    const frame = { width: 60, rows: 20, border: false };
    const app = renderObservable(<SelectView spec={of} layout={selectLayout(of, state, selectText(of, frame), frame, extra.error === undefined ? 0 : 1, false)} state={state} border={false} keys={DEFAULT_KEY_TABLE} sending={extra.sending === true} settling={false} {...(extra.error === undefined ? {} : { error: extra.error })} />);
    const shown = app.lastFrame() ?? '';
    app.unmount();
    return shown;
  };

  it('numbers a row by its place in the filtered list', () => {
    const of = spec({ filter: true, rows: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }, { label: 'Betamax' }] });
    const filtered = after(of, [['b'], ['e']]).state;
    expect(drawn(of, filtered).split('\n').slice(0, 3)).toEqual(['filter: be', '› 1. beta', '  2. Betamax']);
  });

  it('marks the highlighted row, numbers every row and says which cannot be chosen', () => {
    const of = spec({ title: 'Models', rows: [{ label: 'a' }, { label: 'b', disabled: true }, { label: 'found by search', separator: true }, { label: 'c' }] });
    expect(drawn(of, selectStart(of)).split('\n')).toEqual(['Models', '› 1. a', '  2. b (unavailable)', '  found by search', '  3. c', '1-9 or enter to choose · up/down to move · esc: go back']);
  });

  it('shows the filter and its matches', () => {
    const of = spec({ filter: true, rows: [{ label: 'alpha' }, { label: 'beta' }] });
    const state = after(of, [['b']]).state;
    expect(drawn(of, state).split('\n')).toEqual(['filter: b', '› 1. beta', 'enter to choose · up/down to move · type to filter · esc: go back']);
  });

  it('shows sending... in the place of the hint after a decision was sent, and the error of a failed send above the hint', () => {
    const of = spec({ rows: labels(2) });
    expect(drawn(of, selectStart(of), { sending: true }).split('\n').at(-1)).toBe('sending...');
    expect(drawn(of, selectStart(of), { error: 'the daemon refused' }).split('\n').slice(-2)).toEqual(['the daemon refused', '1-9 or enter to choose · up/down to move · esc: go back']);
  });
});

describe('a row keeps its key, its value and its kept text readable at every width', () => {
  const KEY = '77. Time a starting daemon process may go without reporting progress before it is restarted (ms)';

  it('puts all three on one line when they fit', () => {
    expect(choiceLines({ key: 'Mouse', value: 'off  user', kept: 'applies now' }, '› ', 60, true)).toEqual(['› Mouse  off  user  applies now']);
  });

  it('moves the kept text whole to its own line and shortens the key in its middle, keeping its last word, so the value stays whole', () => {
    const lines = choiceLines({ key: KEY, value: '45000  user', kept: 'applies when the daemon next starts' }, '› ', 36, true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^› 77\. Time a.*….*\(ms\)  45000  user$/);
    expect(lines[0]?.length).toBeLessThanOrEqual(36);
    expect(lines[1]?.trim()).toBe('applies when the daemon next starts');
  });

  it('puts a value too wide for any key on its own lines under the highlighted row, whole', () => {
    const value = '/opt/tools/search/bin/ripgrep-from-the-team-share  user';
    const lines = choiceLines({ key: '21. ripgrep program', value, kept: 'applies now' }, '› ', 36, true);
    expect(lines[0]).toBe('› 21. ripgrep program');
    expect(lines.slice(1, -1).join('').replace(/\s+/g, '')).toBe(value.replace(/\s+/g, ''));
    expect(lines.at(-1)?.trim()).toBe('applies now');
  });

  it('starts the value early on a row that is not highlighted, with the key at its shortest', () => {
    const value = '/opt/tools/search/bin/ripgrep-from-the-team-share  user';
    const [line] = choiceLines({ key: KEY, value }, '  ', 36, false);
    expect(line?.indexOf(value)).toBeLessThanOrEqual(2 + 12 + 2);
    expect(line?.slice(2, line.indexOf('  /'))).toMatch(/^77\..*….*\(ms\)$/);
  });
});

describe('a row that carries a value the arrows change', () => {
  const stepped = spec({ rows: [{ label: 'a', steps: { name: 'effort', values: ['low', 'medium', 'high'], at: 1 } }, { label: 'b' }], decideOn: 'enter', stepsLabel: 'change the effort' });

  it('moves the value of the highlighted row within its values, shows it marked, and gives it with the choice', () => {
    const right = press(stepped, selectStart(stepped), '', { rightArrow: true });
    const further = press(stepped, right.state, '', { rightArrow: true });
    expect(further.state.steps).toEqual({ 0: 2 });
    const chosen = press(stepped, further.state, '\r', { return: true });
    expect(chosen.outcome).toEqual({ kind: 'decide', index: 0, step: 2 });
    const left = press(stepped, selectStart(stepped), '', { leftArrow: true });
    expect(press(stepped, left.state, '\r', { return: true }).outcome).toEqual({ kind: 'decide', index: 0, step: 0 });
  });

  it('leaves a row without values unchanged and names the keys in the hint', () => {
    const onB = press(stepped, selectStart(stepped), '', { downArrow: true });
    expect(press(stepped, onB.state, '', { rightArrow: true }).state.steps).toEqual({});
    expect(selectHint(stepped, DEFAULT_KEY_TABLE)).toContain('left/right: change the effort');
  });
});
