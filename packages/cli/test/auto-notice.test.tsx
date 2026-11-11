import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';
import { autoNoticeDue } from '../src/tui/notices.ts';
import { untilOutput } from './ink-helpers.ts';
import { start } from './tui-harness.tsx';

type Key = { classifier: string; codeDigest: string; datasetDigest: string };
type Pair = { key: Key; measurement: 'passed' | 'did_not_pass' | 'not_measured' };

const KEY_A: Key = { classifier: 'model-a', codeDigest: 'code', datasetDigest: 'dataset' };
const KEY_B: Key = { classifier: 'model-b', codeDigest: 'code', datasetDigest: 'dataset' };

const PAIRS: Pair[] = [
  { key: KEY_A, measurement: 'not_measured' },
  { key: KEY_A, measurement: 'passed' },
  { key: KEY_B, measurement: 'passed' },
  { key: KEY_B, measurement: 'did_not_pass' },
];

const sameKey = (left: Key, right: Key): boolean => left.classifier === right.classifier && left.codeDigest === right.codeDigest && left.datasetDigest === right.datasetDigest;

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
    return previous === undefined || !sameKey(previous.key, entry.key) || previous.measurement !== entry.measurement ? [index] : [];
  });

describe('when the auto notice shows (F7)', () => {
  it('shows on the first entry and again only when the classifier key or its measurement changed, over every sequence of four entries', () => {
    const all = [1, 2, 3, 4].flatMap(sequences);
    expect(all).toHaveLength(4 + 16 + 64 + 256);
    for (const entries of all) expect(shownBy(entries)).toEqual(expectedShown(entries));
  });

  it('does not repeat on a Shift+Tab pass through auto with nothing changed, even for an equal key object', () => {
    const pair = PAIRS[1] as Pair;
    expect(autoNoticeDue(undefined, pair)).toBe(true);
    expect(autoNoticeDue(pair, { key: { ...pair.key }, measurement: pair.measurement })).toBe(false);
  });

  it('shows again when the alias stays the same but its classifier moves from one passed key to another', () => {
    const before = { alias: 'guard', key: KEY_A, measurement: 'passed' as const };
    const after = { alias: 'guard', key: KEY_B, measurement: 'passed' as const };
    expect(autoNoticeDue(before, after)).toBe(true);
  });
});

const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('the auto notice in the TUI', () => {
  it('shows the line autoModeNotice renders for the tui surface from the view of a session that starts in auto', async () => {
    const notice = (protocol as unknown as { autoModeNotice?: (input: { view: unknown; surface: 'tui' | 'cli' }) => string }).autoModeNotice;
    if (notice === undefined) throw new Error('@momonga/protocol does not export autoModeNotice');
    const view = { alias: 'guard', key: KEY_A, measurement: 'not_measured' };
    const line = notice({ view, surface: 'tui' });
    const { app } = await start({ session: { permissionMode: 'auto', ...({ autoClassifier: view } as object) }, autoModeAvailable: true } as never);
    await untilOutput(app, 'mode: auto');
    await untilOutput(app, (output) => flat(output).includes(flat(line)));
    expect(flat(app.frames.join('\n'))).toContain(flat(line));
    expect(flat(app.frames.join('\n'))).not.toContain('momonga auto-mode check');
    app.unmount();
  });
});
