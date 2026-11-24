import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';
import type { AutoClassifierView } from '@momonga/protocol';
import { autoNoticeDue } from '../src/tui/notices.ts';
import { KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import { start, type } from './tui-harness.tsx';
import { freshPlace, writeSettings } from './tui/settings-harness.tsx';

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

describe('the auto notice after /auto-mode changes the classifier in the TUI (E)', () => {
  const CLASSIFIER_SESSION_MODEL = 'lmstudio/gemma-3-4b';
  const CLASSIFIER_OTHER_MODEL = 'ollama/qwen3.8:27b';
  const SESSION_CLASSIFIER_VIEW: AutoClassifierView = { model: CLASSIFIER_SESSION_MODEL, key: { ...KEY_A, classifier: CLASSIFIER_SESSION_MODEL }, measurement: 'not_measured' };
  const OTHER_CLASSIFIER_VIEW: AutoClassifierView = { model: CLASSIFIER_OTHER_MODEL, key: { ...KEY_B, classifier: CLASSIFIER_OTHER_MODEL }, measurement: 'not_measured' };
  const RESULT_OTHER = `The auto-mode classifier is now ${CLASSIFIER_OTHER_MODEL}.`;
  const RESULT_SESSION = "The auto-mode classifier is now the session's model.";

  const twoModelSettings = (classifier?: string) => ({
    models: {
      connections: [
        { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] },
        { adapter: 'chat-completions', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', billing: 'local', maxConcurrency: 1, models: [{ id: 'gemma-3-4b', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }] },
      ],
    },
    ...(classifier === undefined ? {} : { autoMode: { classifier } }),
  });

  const startWithSettings = async (options: {
    permissionMode: 'auto' | 'manual';
    initialAutoClassifier?: AutoClassifierView;
    configuredClassifier?: string;
    classifierViews?: Readonly<Record<string, AutoClassifierView | null>>;
    sessionFailure?: Error;
  }) => {
    const place = freshPlace();
    writeSettings(place.userFile, twoModelSettings(options.configuredClassifier));
    const started = await start({
      models: [CLASSIFIER_SESSION_MODEL, CLASSIFIER_OTHER_MODEL],
      settingsPlace: { home: place.home, projectDir: place.project },
      session: {
        model: CLASSIFIER_SESSION_MODEL,
        permissionMode: options.permissionMode,
        ...(options.initialAutoClassifier === undefined ? {} : { autoClassifier: options.initialAutoClassifier }),
      },
      ...(options.classifierViews === undefined ? {} : { classifierViews: options.classifierViews }),
      ...(options.sessionFailure === undefined ? {} : { sessionFailure: options.sessionFailure }),
    });
    await untilOutput(started.app, `mode: ${options.permissionMode}`);
    return started;
  };

  const waitForInputReturned = (app: StartedApp): Promise<string> =>
    untilFrame(app, (frame) => !frame.includes('esc: go back') && !frame.includes('to choose') && frame.includes('│ >'));

  const openAutoModeList = async (app: StartedApp): Promise<string> => {
    await type(app, '/auto-mode', '> /auto-mode');
    app.stdin.write(KEYS.enter);
    return untilFrame(app, (frame) => frame.includes('Auto-mode classifier') && frame.includes('esc: go back'));
  };

  const answerConfirm = async (app: StartedApp, answer: 'Yes' | 'No'): Promise<void> => {
    await untilFrame(app, (frame) => frame.includes('for the auto-mode classifier?') && frame.includes('1. No'));
    if (answer === 'Yes') {
      app.stdin.write(KEYS.down);
      await untilFrame(app, (frame) => frame.includes('› 2. Yes'));
    }
    app.stdin.write(KEYS.enter);
  };

  const pickOtherClassifier = async (app: StartedApp, answer: 'Yes' | 'No'): Promise<void> => {
    const opened = await openAutoModeList(app);
    expect(opened).toContain(`› 1. ${CLASSIFIER_OTHER_MODEL}`);
    app.stdin.write(KEYS.enter);
    await answerConfirm(app, answer);
  };

  const pickSessionModelClassifier = async (app: StartedApp, answer: 'Yes' | 'No'): Promise<void> => {
    await openAutoModeList(app);
    app.stdin.write(KEYS.down);
    await untilFrame(app, (frame) => frame.includes(`› 2. ${CLASSIFIER_SESSION_MODEL}`));
    app.stdin.write(KEYS.down);
    await untilFrame(app, (frame) => frame.includes("› 3. Use the session's model"));
    app.stdin.write(KEYS.enter);
    await answerConfirm(app, answer);
  };

  const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it('1: in auto, choosing another model B and confirming Yes prints the result line then the notice for B', async () => {
    const initialNotice = noticeOf(SESSION_CLASSIFIER_VIEW, CLASSIFIER_SESSION_MODEL);
    const afterNotice = noticeOf(OTHER_CLASSIFIER_VIEW, CLASSIFIER_OTHER_MODEL);
    const { app, backend } = await startWithSettings({
      permissionMode: 'auto',
      initialAutoClassifier: SESSION_CLASSIFIER_VIEW,
      classifierViews: { [CLASSIFIER_SESSION_MODEL]: SESSION_CLASSIFIER_VIEW, [CLASSIFIER_OTHER_MODEL]: OTHER_CLASSIFIER_VIEW },
    });
    await untilOutput(app, (output) => flat(output).includes(flat(initialNotice)));

    await pickOtherClassifier(app, 'Yes');
    await untilOutput(app, RESULT_OTHER);
    const shown = await untilOutput(app, (output) => flat(output).includes(flat(afterNotice)));
    expect(backend.calls).toContain('session');
    const resultPos = flat(shown).indexOf(RESULT_OTHER);
    const noticePos = flat(shown).indexOf(flat(afterNotice));
    expect(resultPos).toBeGreaterThanOrEqual(0);
    expect(resultPos).toBeLessThan(noticePos);
    app.unmount();
  });

  it("2: in auto, choosing Use the session's model and confirming Yes prints the result line then the notice for the session's model", async () => {
    const initialNotice = noticeOf(OTHER_CLASSIFIER_VIEW, CLASSIFIER_OTHER_MODEL);
    const afterNotice = noticeOf(SESSION_CLASSIFIER_VIEW, CLASSIFIER_SESSION_MODEL);
    const { app, backend } = await startWithSettings({
      permissionMode: 'auto',
      configuredClassifier: CLASSIFIER_OTHER_MODEL,
      initialAutoClassifier: OTHER_CLASSIFIER_VIEW,
      classifierViews: { [CLASSIFIER_SESSION_MODEL]: SESSION_CLASSIFIER_VIEW, [CLASSIFIER_OTHER_MODEL]: OTHER_CLASSIFIER_VIEW },
    });
    await untilOutput(app, (output) => flat(output).includes(flat(initialNotice)));

    await pickSessionModelClassifier(app, 'Yes');
    await untilOutput(app, RESULT_SESSION);
    const shown = await untilOutput(app, (output) => flat(output).includes(flat(afterNotice)));
    expect(backend.calls).toContain('session');
    const resultPos = flat(shown).indexOf(RESULT_SESSION);
    const noticePos = flat(shown).indexOf(flat(afterNotice));
    expect(resultPos).toBeGreaterThanOrEqual(0);
    expect(resultPos).toBeLessThan(noticePos);
    app.unmount();
  });

  it('3: in auto, choosing the same model as the last shown notice prints the result line and does not repeat the notice', async () => {
    const initialNotice = noticeOf(OTHER_CLASSIFIER_VIEW, CLASSIFIER_OTHER_MODEL);
    const { app, backend } = await startWithSettings({
      permissionMode: 'auto',
      configuredClassifier: CLASSIFIER_OTHER_MODEL,
      initialAutoClassifier: OTHER_CLASSIFIER_VIEW,
      classifierViews: { [CLASSIFIER_SESSION_MODEL]: SESSION_CLASSIFIER_VIEW, [CLASSIFIER_OTHER_MODEL]: OTHER_CLASSIFIER_VIEW },
    });
    await untilOutput(app, (output) => flat(output).includes(flat(initialNotice)));

    await pickOtherClassifier(app, 'Yes');
    await untilOutput(app, RESULT_OTHER);
    await waitForInputReturned(app);
    await backend.called('session');
    await nextCommandShown(app);
    const finalFrame = flat(app.lastFrame() ?? '');
    expect(backend.calls).toContain('session');
    expect(countOccurrences(finalFrame, flat(initialNotice))).toBe(1);
    const resultPos = finalFrame.indexOf(RESULT_OTHER);
    expect(resultPos).toBeGreaterThanOrEqual(0);
    expect(finalFrame.slice(resultPos)).not.toContain(flat(initialNotice));
    app.unmount();
  });

  it('4: outside auto, changing the classifier prints only the result line without reading the session, and shows the notice when entering auto next', async () => {
    const afterNotice = noticeOf(OTHER_CLASSIFIER_VIEW, CLASSIFIER_OTHER_MODEL);
    const { app, backend } = await startWithSettings({
      permissionMode: 'manual',
      classifierViews: { [CLASSIFIER_SESSION_MODEL]: SESSION_CLASSIFIER_VIEW, [CLASSIFIER_OTHER_MODEL]: OTHER_CLASSIFIER_VIEW },
    });

    await pickOtherClassifier(app, 'Yes');
    await untilOutput(app, RESULT_OTHER);
    await waitForInputReturned(app);
    const beforeAuto = await nextCommandShown(app);
    expect(backend.calls).not.toContain('session');
    expect(flat(beforeAuto)).not.toContain('auto: classifier');

    await type(app, '/mode auto', '> /mode auto');
    app.stdin.write(KEYS.enter);
    const entered = await untilOutput(app, (output) => flat(output).includes(flat(afterNotice)));
    expect(flat(entered)).toContain(flat(afterNotice));
    app.unmount();
  });

  it('5: in auto, when the new classifier has no probe key (no autoClassifier view), prints the result line and no notice', async () => {
    const initialNotice = noticeOf(SESSION_CLASSIFIER_VIEW, CLASSIFIER_SESSION_MODEL);
    const { app, backend } = await startWithSettings({
      permissionMode: 'auto',
      initialAutoClassifier: SESSION_CLASSIFIER_VIEW,
      classifierViews: { [CLASSIFIER_SESSION_MODEL]: SESSION_CLASSIFIER_VIEW, [CLASSIFIER_OTHER_MODEL]: null },
    });
    await untilOutput(app, (output) => flat(output).includes(flat(initialNotice)));

    await pickOtherClassifier(app, 'Yes');
    await untilOutput(app, RESULT_OTHER);
    await waitForInputReturned(app);
    await backend.called('session');
    const shown = await nextCommandShown(app);
    expect(backend.calls).toContain('session');
    expect(flat(shown)).not.toContain(`auto: classifier ${CLASSIFIER_OTHER_MODEL}`);
    app.unmount();
  });

  it('6: in auto, when rereading the session fails after writing, prints the error line after the result line and no notice', async () => {
    const initialNotice = noticeOf(SESSION_CLASSIFIER_VIEW, CLASSIFIER_SESSION_MODEL);
    const { app, backend } = await startWithSettings({
      permissionMode: 'auto',
      initialAutoClassifier: SESSION_CLASSIFIER_VIEW,
      classifierViews: { [CLASSIFIER_SESSION_MODEL]: SESSION_CLASSIFIER_VIEW, [CLASSIFIER_OTHER_MODEL]: OTHER_CLASSIFIER_VIEW },
      sessionFailure: new Error('runtime session read failed'),
    });
    await untilOutput(app, (output) => flat(output).includes(flat(initialNotice)));

    await pickOtherClassifier(app, 'Yes');
    await untilOutput(app, 'runtime session read failed');
    await waitForInputReturned(app);
    const shown = await nextCommandShown(app);
    expect(backend.calls).toContain('session');
    const resultPos = flat(shown).indexOf(RESULT_OTHER);
    const errorPos = flat(shown).indexOf('runtime session read failed');
    expect(resultPos).toBeGreaterThanOrEqual(0);
    expect(resultPos).toBeLessThan(errorPos);
    expect(flat(shown)).not.toContain(`auto: classifier ${CLASSIFIER_OTHER_MODEL}`);
    app.unmount();
  });

  it('7: answering No or closing the list with Esc prints nothing and does not reread the session', async () => {
    const initialNotice = noticeOf(SESSION_CLASSIFIER_VIEW, CLASSIFIER_SESSION_MODEL);
    const { app, backend } = await startWithSettings({
      permissionMode: 'auto',
      initialAutoClassifier: SESSION_CLASSIFIER_VIEW,
      classifierViews: { [CLASSIFIER_SESSION_MODEL]: SESSION_CLASSIFIER_VIEW, [CLASSIFIER_OTHER_MODEL]: OTHER_CLASSIFIER_VIEW },
    });
    await untilOutput(app, (output) => flat(output).includes(flat(initialNotice)));

    await pickOtherClassifier(app, 'No');
    await waitForInputReturned(app);
    await openAutoModeList(app);
    app.stdin.write(KEYS.escape);
    await waitForInputReturned(app);
    const shown = await nextCommandShown(app);
    expect(backend.calls).not.toContain('session');
    expect(flat(shown)).not.toContain(RESULT_OTHER);
    expect(flat(shown)).not.toContain(`auto: classifier ${CLASSIFIER_OTHER_MODEL}`);
    app.unmount();
  });
});
