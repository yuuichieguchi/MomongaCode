import { SCRIPTED_MODEL, pollUntil } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { MemoryJudgementView } from '@momonga/protocol';
import { SESSION, runView } from '../fake-backend.ts';
import type { FakeBackend, FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { frame, runStarted, start, type } from '../tui-harness.tsx';

const WIDE = { columns: 220, rows: 70 };
const BUSY_HINT = 'enter: steer after the next tool call · tab: queue for after this run · esc: stop';
const IDLE = /^(?![\s\S]*esc to cancel)[\s\S]*mode: \w+ \(shift\+tab\)/;

const CLASSIFIER = 'openai/gpt-5-mini';
const FAILURE = 'the classifier stream ended without a terminal event';

const judgement = (memoryId: string, overrides: Partial<MemoryJudgementView> = {}): MemoryJudgementView => ({
  memoryId,
  outcome: 'left',
  classifier: CLASSIFIER,
  verdict: 'unsafe',
  confidence: 'high',
  judgedAt: 1,
  owed: true,
  closed: false,
  ...overrides,
});

const KEPT = judgement('mem-1', { outcome: 'kept', verdict: 'safe', confidence: 'high' });
const KEPT_LINE = 'auto review kept memory mem-1; model openai/gpt-5-mini judged it safe with high confidence';
const SAFE_LOW = judgement('mem-2', { verdict: 'safe', confidence: 'low' });
const SAFE_LOW_LINE = 'auto review left memory mem-2 waiting; model openai/gpt-5-mini judged it safe without high confidence';
const UNSAFE = judgement('mem-3');
const UNSAFE_LINE = 'auto review left memory mem-3 waiting; model openai/gpt-5-mini judged it unsafe';
const FAILED = { memoryId: 'mem-4', outcome: 'left', failure: FAILURE, judgedAt: 1, owed: true, closed: false } as const satisfies MemoryJudgementView;
const FAILED_LINE = `auto review left memory mem-4 waiting; ${FAILURE}`;

const BOUND = { boundMs: 3000 };

const marked = (backend: FakeBackend): string[] => backend.calls.filter((call) => call.startsWith('memory-judgements-shown:')).flatMap((call) => call.slice('memory-judgements-shown:'.length).split(','));

const seen = (backend: FakeBackend, call: string): Promise<void> => pollUntil(() => backend.calls.includes(call), { ...BOUND, description: `the backend saw ${call}` });

const timesShown = (shown: string, line: string): number => shown.split(line).length - 1;

const judgementCalls = (backend: FakeBackend): string[] => backend.calls.filter((call) => call.startsWith('session-stream-open:') || call.startsWith('memory-judgement'));

const opened = async (options: FakeBackendOptions = {}): Promise<{ backend: FakeBackend; app: Instance }> => {
  const started = await start(options, {}, WIDE);
  await untilFrame(started.app, IDLE);
  await runStarted(started.backend, started.app, 'one');
  await untilFrame(started.app, BUSY_HINT);
  return started;
};

const idle = async (options: FakeBackendOptions = {}): Promise<{ backend: FakeBackend; app: Instance }> => {
  const started = await opened(options);
  started.backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
  started.backend.finish(runView());
  await untilFrame(started.app, (now) => !now.includes(BUSY_HINT) && IDLE.test(now));
  return started;
};

describe('a memory auto review judged, in the terminal UI', () => {
  it('reads the record on memory.judged, prints the line of an owed record, then marks it shown', async () => {
    const { backend, app } = await idle();
    backend.judgements.set('mem-1', KEPT);
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory('mem-1');
    const shown = await untilFrame(app, KEPT_LINE);
    await seen(backend, 'memory-judgements-shown:mem-1');

    expect(timesShown(shown, KEPT_LINE)).toBe(1);
    const calls = judgementCalls(backend);
    expect(calls.indexOf('memory-judgement:mem-1')).toBeLessThan(calls.indexOf('memory-judgements-shown:mem-1'));
    app.unmount();
  });

  it.each([
    ['safe without high confidence', SAFE_LOW, SAFE_LOW_LINE],
    ['unsafe', UNSAFE, UNSAFE_LINE],
    ['a classifier failure', FAILED, FAILED_LINE],
  ] as const)('prints the line of %s', async (_name, record, line) => {
    const { backend, app } = await idle();
    backend.judgements.set(record.memoryId, record);
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory(record.memoryId);

    expect(timesShown(await untilFrame(app, line), line)).toBe(1);
    app.unmount();
  });

  it('prints the line of a record another session already marked shown, and marks it shown again', async () => {
    const { backend, app } = await idle();
    backend.judgements.set('mem-1', { ...KEPT, owed: false, closed: false });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory('mem-1');
    const shown = await untilFrame(app, KEPT_LINE);
    await seen(backend, 'memory-judgements-shown:mem-1');

    expect(timesShown(shown, KEPT_LINE)).toBe(1);
    const calls = judgementCalls(backend);
    expect(calls.indexOf('memory-judgement:mem-1')).toBeLessThan(calls.indexOf('memory-judgements-shown:mem-1'));
    app.unmount();
  });

  it('prints nothing and marks nothing for a closed record the person decided', async () => {
    const { backend, app } = await idle();
    backend.judgements.set('mem-1', { ...KEPT, owed: false, closed: true });
    backend.judgements.set('mem-3', UNSAFE);
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory('mem-1');
    await seen(backend, 'memory-judgement:mem-1');
    backend.judgeMemory('mem-3');
    const shown = await untilFrame(app, UNSAFE_LINE);
    await seen(backend, 'memory-judgements-shown:mem-3');

    expect(shown).not.toContain('memory mem-1');
    expect(backend.calls.filter((call) => call.startsWith('memory-judgements-shown:'))).toEqual(['memory-judgements-shown:mem-3']);
    app.unmount();
  });

  it('prints the line at once while a run is active, in the middle of its output', async () => {
    const { backend, app } = await opened();
    backend.judgements.set('mem-1', KEPT);
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'halfway there' }));
    await untilFrame(app, 'halfway there');
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory('mem-1');
    const shown = await untilFrame(app, KEPT_LINE);

    expect(shown).toContain(BUSY_HINT);
    expect(shown.indexOf('halfway there')).toBeLessThan(shown.indexOf(KEPT_LINE));
    app.unmount();
  });
});

describe('the owed records when the session stream connects', () => {
  it('reads the owed records of the folder only after the stream connected, prints them in review order, then marks them shown', async () => {
    const { backend, app } = await opened({ memoryJudgements: [KEPT, UNSAFE], sessionStreamHeld: true });
    await untilFrame(app, BUSY_HINT);
    expect(backend.calls.some((call) => call.startsWith('memory-judgements:'))).toBe(false);

    backend.connectSessionStream();
    const shown = await untilFrame(app, (now) => now.includes(KEPT_LINE) && now.includes(UNSAFE_LINE));
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    await pollUntil(() => marked(backend).length === 2, { ...BOUND, description: 'both records are marked shown' });

    expect(shown.indexOf(KEPT_LINE)).toBeLessThan(shown.indexOf(UNSAFE_LINE));
    const calls = judgementCalls(backend);
    const read = calls.indexOf(`memory-judgements:${SESSION.cwd}`);
    expect(calls.indexOf(`session-stream-open:${SESSION.id}`)).toBeLessThan(read);
    const marks = calls.flatMap((call, index) => (call.startsWith('memory-judgements-shown:') ? [index] : []));
    expect(marks.every((index) => index > read)).toBe(true);
    expect(marked(backend).sort()).toEqual(['mem-1', 'mem-3']);
    app.unmount();
  });

  it('prints an arriving memory.judged before the read of the owed records has answered', async () => {
    const held = Promise.withResolvers<void>();
    const { backend, app } = await opened({ owedReadHeld: held.promise });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    backend.judgements.set('mem-1', KEPT);

    backend.judgeMemory('mem-1');
    await untilFrame(app, KEPT_LINE);

    held.resolve();
    app.unmount();
  });

  it('reads the owed records again at every reconnect', async () => {
    const { backend, app } = await idle({ memoryJudgements: [] });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    backend.judgements.set('mem-3', UNSAFE);

    backend.connectSessionStream();
    await untilFrame(app, UNSAFE_LINE);

    expect(backend.calls.filter((call) => call === `memory-judgements:${SESSION.cwd}`)).toHaveLength(2);
    app.unmount();
  });

  it('does the same for the new session when the UI follows another session', async () => {
    const { backend, app } = await idle({ memoryJudgements: [] });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    backend.judgements.set('mem-3', UNSAFE);

    await type(app, '/clear', '> /clear');
    app.stdin.write(KEYS.enter);
    await pollUntil(() => backend.inboxFollowers.length === 2, { ...BOUND, description: 'the new session is followed' });
    await untilFrame(app, UNSAFE_LINE);

    const followed = backend.inboxFollowers[1]?.sessionId;
    expect(followed).not.toBe(SESSION.id);
    const calls = judgementCalls(backend);
    const reads = calls.flatMap((call, index) => (call === `memory-judgements:${SESSION.cwd}` ? [index] : []));
    expect(reads).toHaveLength(2);
    expect(calls.indexOf(`session-stream-open:${followed}`)).toBeLessThan(reads[1] ?? -1);
    app.unmount();
  });
});

describe('one terminal UI prints a record at most once', () => {
  it('prints a record that arrives by event and by the owed read once', async () => {
    const held = Promise.withResolvers<void>();
    const { backend, app } = await opened({ memoryJudgements: [KEPT], owedReadHeld: held.promise });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory('mem-1');
    await untilFrame(app, KEPT_LINE);
    held.resolve();
    backend.judgements.set('mem-3', UNSAFE);
    backend.judgeMemory('mem-3');
    const shown = await untilFrame(app, UNSAFE_LINE);
    await seen(backend, 'memory-judgements-shown:mem-3');

    expect(timesShown(shown, KEPT_LINE)).toBe(1);
    app.unmount();
  });

  it('prints a record that arrives by two events once', async () => {
    const { backend, app } = await idle();
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    backend.judgements.set('mem-1', KEPT);
    backend.judgements.set('mem-3', UNSAFE);

    backend.judgeMemory('mem-1');
    await untilFrame(app, KEPT_LINE);
    backend.judgeMemory('mem-1');
    backend.judgeMemory('mem-3');
    const shown = await untilFrame(app, UNSAFE_LINE);
    await seen(backend, 'memory-judgements-shown:mem-3');

    expect(timesShown(shown, KEPT_LINE)).toBe(1);
    app.unmount();
  });

  it('prints a record still owed after a reconnect once', async () => {
    const { backend, app } = await idle({ memoryJudgements: [KEPT] });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    await untilFrame(app, KEPT_LINE);
    await seen(backend, 'memory-judgements-shown:mem-1');

    backend.connectSessionStream();
    await pollUntil(() => backend.calls.filter((call) => call === `memory-judgements:${SESSION.cwd}`).length === 2, { ...BOUND, description: 'the owed records are read again' });
    backend.judgements.set('mem-3', UNSAFE);
    backend.judgeMemory('mem-3');
    const shown = await untilFrame(app, UNSAFE_LINE);

    expect(timesShown(shown, KEPT_LINE)).toBe(1);
    app.unmount();
  });
});

describe('failures of the reads and of the mark', () => {
  it('reports a failed read of the owed records and stays usable', async () => {
    const { backend, app } = await idle({ owedReadFailure: new Error('the owed read broke') });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    await untilFrame(app, 'the owed read broke');

    await type(app, 'still here', '> still here');
    expect(backend.calls.some((call) => call.startsWith('memory-judgements-shown:'))).toBe(false);
    app.unmount();
  });

  it('prints the line even when the mark fails, tries the mark once, and stays usable', async () => {
    const { backend, app } = await idle({ markShownFailure: new Error('the mark broke') });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    backend.judgements.set('mem-1', KEPT);

    backend.judgeMemory('mem-1');
    await untilFrame(app, KEPT_LINE);
    await seen(backend, 'memory-judgements-shown:mem-1');
    await untilFrame(app, 'the mark broke');
    backend.judgements.set('mem-3', UNSAFE);
    backend.judgeMemory('mem-3');
    await untilFrame(app, UNSAFE_LINE);
    await seen(backend, 'memory-judgements-shown:mem-3');

    expect(backend.calls.filter((call) => call === 'memory-judgements-shown:mem-1')).toHaveLength(1);
    await type(app, 'still here', '> still here');
    app.unmount();
  });

  it('prints the line while the mark has not answered', async () => {
    const held = Promise.withResolvers<void>();
    const { backend, app } = await idle({ markShownHeld: held.promise });
    await seen(backend, `memory-judgements:${SESSION.cwd}`);
    backend.judgements.set('mem-1', KEPT);

    backend.judgeMemory('mem-1');
    await untilFrame(app, KEPT_LINE);

    held.resolve();
    app.unmount();
  });
});

const CANON = 'ollama/gemma-3-4b:latest';
const DISPLAY = 'ollama/gemma-3-4b';
const UNCONFIGURED = 'openai/gpt-9';
const WITH_GEMMA: FakeBackendOptions = { models: [SCRIPTED_MODEL, CANON] };

const BY_CANON = [
  ['safe with high confidence', judgement('mem-1', { outcome: 'kept', verdict: 'safe', confidence: 'high', classifier: CANON }), `auto review kept memory mem-1; model ${DISPLAY} judged it safe with high confidence`],
  ['safe without high confidence', judgement('mem-2', { verdict: 'safe', confidence: 'low', classifier: CANON }), `auto review left memory mem-2 waiting; model ${DISPLAY} judged it safe without high confidence`],
  ['unsafe', judgement('mem-3', { classifier: CANON }), `auto review left memory mem-3 waiting; model ${DISPLAY} judged it unsafe`],
] as const;

const UNKNOWN = judgement('mem-5', { classifier: UNCONFIGURED });
const UNKNOWN_LINE = `auto review left memory mem-5 waiting; model ${UNCONFIGURED} judged it unsafe`;

describe('the model of a judgement is named by its display', () => {
  it.each(BY_CANON)('names the model by its display on memory.judged when %s', async (_name, record, line) => {
    const { backend, app } = await idle(WITH_GEMMA);
    backend.judgements.set(record.memoryId, record);
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory(record.memoryId);
    await seen(backend, `memory-judgements-shown:${record.memoryId}`);

    const shown = await untilFrame(app, `memory ${record.memoryId}`);
    expect(shown).toContain(line);
    expect(shown).not.toContain(CANON);
    expect(backend.judgements.get(record.memoryId)?.classifier).toBe(CANON);
    app.unmount();
  });

  it('keeps the failure line as it is on memory.judged', async () => {
    const { backend, app } = await idle(WITH_GEMMA);
    backend.judgements.set(FAILED.memoryId, FAILED);
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory(FAILED.memoryId);

    expect(timesShown(await untilFrame(app, FAILED_LINE), FAILED_LINE)).toBe(1);
    app.unmount();
  });

  it('names a stored model that is not among the configured models as it is stored on memory.judged', async () => {
    const { backend, app } = await idle(WITH_GEMMA);
    backend.judgements.set(UNKNOWN.memoryId, UNKNOWN);
    await seen(backend, `memory-judgements:${SESSION.cwd}`);

    backend.judgeMemory(UNKNOWN.memoryId);

    expect(timesShown(await untilFrame(app, UNKNOWN_LINE), UNKNOWN_LINE)).toBe(1);
    app.unmount();
  });

  it('names every model by its display, a failure as it is and an unconfigured model as stored on the read of the owed records at connect', async () => {
    const records = [...BY_CANON.map(([, record]) => record), FAILED, UNKNOWN];
    const { backend, app } = await opened({ ...WITH_GEMMA, memoryJudgements: records, sessionStreamHeld: true });

    backend.connectSessionStream();
    await pollUntil(() => marked(backend).length === records.length, { ...BOUND, description: 'every owed record is marked shown' });
    const shown = await untilFrame(app, (now) => now.includes('memory mem-5'));

    for (const [, , line] of BY_CANON) expect(shown).toContain(line);
    expect(shown).toContain(FAILED_LINE);
    expect(shown).toContain(UNKNOWN_LINE);
    expect(shown).not.toContain(CANON);
    app.unmount();
  });
});
