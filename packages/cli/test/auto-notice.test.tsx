import { describe, expect, it } from 'vitest';
import { autoNoticeDue } from '../src/tui/notices.ts';
import { untilOutput } from './ink-helpers.ts';
import { start } from './tui-harness.tsx';

type Pair = { alias: string; measurement: 'passed' | 'did_not_pass' | 'not_measured' };

const PAIRS: Pair[] = [
  { alias: 'guard', measurement: 'not_measured' },
  { alias: 'guard', measurement: 'passed' },
  { alias: 'other', measurement: 'not_measured' },
  { alias: 'other', measurement: 'did_not_pass' },
];

const sequences = (length: number): Pair[][] =>
  length === 0 ? [[]] : sequences(length - 1).flatMap((prefix) => PAIRS.map((pair) => [...prefix, pair]));

const shownBy = (entries: readonly Pair[]): number[] => {
  const shown: number[] = [];
  let last: Pair | undefined;
  entries.forEach((entry, index) => {
    if (autoNoticeDue(last, entry)) {
      shown.push(index);
      last = entry;
    }
  });
  return shown;
};

const expectedShown = (entries: readonly Pair[]): number[] =>
  entries.flatMap((entry, index) => {
    const previous = entries[index - 1];
    return index === 0 || previous?.alias !== entry.alias || previous.measurement !== entry.measurement ? [index] : [];
  });

describe('when the auto notice shows (F7)', () => {
  it('shows on the first entry and again only when the classifier or its measurement changed, over every sequence of four entries', () => {
    const all = [1, 2, 3, 4].flatMap(sequences);
    expect(all).toHaveLength(4 + 16 + 64 + 256);
    for (const entries of all) expect(shownBy(entries)).toEqual(expectedShown(entries));
  });

  it('does not repeat on a Shift+Tab pass through auto with nothing changed', () => {
    const pair = PAIRS[0] as Pair;
    expect(autoNoticeDue(undefined, pair)).toBe(true);
    expect(autoNoticeDue(pair, { ...pair })).toBe(false);
    expect(autoNoticeDue(pair, PAIRS[1] as Pair)).toBe(true);
  });
});

describe('the auto notice in the TUI', () => {
  it('shows the measurement line of the session view when the session starts in auto', async () => {
    const detail = 'auto: guard not measured; run /auto-mode check';
    const { app } = await start({ session: { permissionMode: 'auto', ...({ autoClassifier: { alias: 'guard', measurement: 'not_measured', detail } } as object) }, autoModeAvailable: true } as never);
    await untilOutput(app, detail);
    app.unmount();
  });
});
