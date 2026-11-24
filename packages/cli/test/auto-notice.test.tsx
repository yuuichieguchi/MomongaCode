import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';
import type { AutoClassifierView } from '@momonga/protocol';
import { autoNoticeDue } from '../src/tui/notices.ts';
import { KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import { start, type } from './tui-harness.tsx';

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

const QWEN = 'ollama/qwen3.8:27b';
const SESSION_MODEL = 'scripted-model';

const noticeOf = (view: unknown, shownModel: string): string => {
  const notice = (protocol as unknown as { autoModeNotice?: (input: { view: unknown; surface: 'tui' | 'cli'; shownModel: string }) => string }).autoModeNotice;
  if (notice === undefined) throw new Error('@momonga/protocol does not export autoModeNotice');
  return notice({ view, surface: 'tui', shownModel });
};

const SESSION_VIEW: AutoClassifierView = { model: SESSION_MODEL, key: { ...KEY_A, classifier: SESSION_MODEL }, measurement: 'not_measured' };
const QWEN_VIEW: AutoClassifierView = { model: QWEN, key: { ...KEY_A, classifier: QWEN }, measurement: 'not_measured' };
const SWITCHED = 'model: ollama/qwen3.8:27b';

type StartedApp = Awaited<ReturnType<typeof start>>['app'];

const nextCommandShown = async (app: StartedApp): Promise<string> => {
  await type(app, '/frobnicate', '> /frobnicate');
  app.stdin.write(KEYS.enter);
  return untilOutput(app, 'unknown command /frobnicate; /help lists the commands');
};

const expectModelLineFirst = (shown: string, notice: string): void => {
  const modelLine = flat(shown).indexOf(`${SWITCHED} (effort: not available); applies from the next run`);
  expect(modelLine).toBeGreaterThanOrEqual(0);
  expect(modelLine).toBeLessThan(flat(shown).indexOf(flat(notice)));
};

describe('the auto notice in the TUI', () => {
  it('shows the line autoModeNotice renders for the tui surface from the view of a session that starts in auto', async () => {
    const view: AutoClassifierView = { model: 'guard', key: KEY_A, measurement: 'not_measured' };
    const line = noticeOf(view, 'guard');
    const { app } = await start({ session: { permissionMode: 'auto', autoClassifier: view } });
    await untilOutput(app, 'mode: auto');
    await untilOutput(app, (output) => flat(output).includes(flat(line)));
    expect(flat(app.frames.join('\n'))).toContain(flat(line));
    expect(flat(app.frames.join('\n'))).not.toContain('momonga auto-mode check');
    app.unmount();
  });

  it('shows the notice of the new classifier after /model switches the session model while the session is in auto', async () => {
    const before = noticeOf(SESSION_VIEW, SESSION_MODEL);
    const after = noticeOf(QWEN_VIEW, QWEN);
    const { app } = await start({ models: [SESSION_MODEL, QWEN], session: { permissionMode: 'auto', autoClassifier: SESSION_VIEW }, classifierViews: { [QWEN]: QWEN_VIEW } });
    await untilOutput(app, 'mode: auto');
    await untilOutput(app, (output) => flat(output).includes(flat(before)));
    await type(app, '/model qwen3.8:27b', '> /model qwen3.8:27b');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, SWITCHED);
    const shown = await untilOutput(app, (output) => flat(output).includes(flat(after)));
    expect(flat(shown)).toContain(flat(after));
    expectModelLineFirst(shown, after);
    app.unmount();
  });

  it('shows the notice of the new classifier after a model is chosen in the /model picker while the session is in auto', async () => {
    const after = noticeOf(QWEN_VIEW, QWEN);
    const { app } = await start({ models: [SESSION_MODEL, QWEN], session: { permissionMode: 'auto', autoClassifier: SESSION_VIEW }, classifierViews: { [QWEN]: QWEN_VIEW } });
    await untilOutput(app, 'mode: auto');
    await type(app, '/model', '> /model');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (shown) => shown.includes('qwen3.8:27b ') && shown.includes('esc: go back'));
    app.stdin.write(KEYS.down);
    app.stdin.write(KEYS.enter);
    await untilOutput(app, SWITCHED);
    const shown = await untilOutput(app, (output) => flat(output).includes(flat(after)));
    expect(flat(shown)).toContain(flat(after));
    expectModelLineFirst(shown, after);
    app.unmount();
  });

  it('shows nothing new after /model when the returned session view has no classifier view', async () => {
    const before = noticeOf(SESSION_VIEW, SESSION_MODEL);
    const { app } = await start({ models: [SESSION_MODEL, QWEN], session: { permissionMode: 'auto', autoClassifier: SESSION_VIEW }, classifierViews: { [QWEN]: null } });
    await untilOutput(app, (output) => flat(output).includes(flat(before)));
    await type(app, '/model qwen3.8:27b', '> /model qwen3.8:27b');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, SWITCHED);
    const shown = await nextCommandShown(app);
    expect(flat(shown)).not.toContain(`auto: classifier ${QWEN}`);
    app.unmount();
  });

  it('shows no notice after /model while the session is not in auto', async () => {
    const { app } = await start({ models: [SESSION_MODEL, QWEN], session: { permissionMode: 'manual', autoClassifier: SESSION_VIEW }, classifierViews: { [QWEN]: QWEN_VIEW } });
    await untilOutput(app, 'mode: manual');
    await type(app, '/model qwen3.8:27b', '> /model qwen3.8:27b');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, SWITCHED);
    const shown = await nextCommandShown(app);
    expect(flat(shown)).not.toContain('auto: classifier');
    app.unmount();
  });
});
