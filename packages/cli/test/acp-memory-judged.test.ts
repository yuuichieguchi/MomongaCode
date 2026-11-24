import { afterMicrotasks, pollUntil } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { MemoryJudgementView } from '@momonga/protocol';
import { SESSION } from './fake-backend.ts';
import { INITIALIZE, MODEL_VIEWS, memoryJudgedFrame, modeChangedFrame, resultOf, startAgent, updatesOf } from './acp-harness.ts';
import type { Harness } from './acp-harness.ts';

const NOTICES = { session: { notices: {} } };

const KEPT_LINE = 'auto review kept memory mem-1; model openai/gpt-5-mini judged it safe with high confidence';

const FAILURE = 'the classifier stream ended without a terminal event';

const OTHER_LINE = 'auto review left memory mem-2 waiting; model openai/gpt-5-mini judged it unsafe';

const kept = (overrides: Partial<MemoryJudgementView> = {}): MemoryJudgementView => ({
  memoryId: 'mem-1',
  outcome: 'kept',
  classifier: 'openai/gpt-5-mini',
  verdict: 'safe',
  confidence: 'high',
  judgedAt: 1,
  owed: true,
  closed: false,
  ...overrides,
});

const unsafe: MemoryJudgementView = { memoryId: 'mem-2', outcome: 'left', classifier: 'openai/gpt-5-mini', verdict: 'unsafe', confidence: 'high', judgedAt: 2, owed: true, closed: false };

const received = (harness: Harness, description: string, predicate: (update: { sessionUpdate: string; [key: string]: unknown }) => boolean): Promise<void> =>
  pollUntil(() => updatesOf(harness.peer.received).some(predicate), { boundMs: 3000, description });

const open = async (harness: Harness, capabilities: unknown = NOTICES): Promise<string> => {
  await harness.peer.request('initialize', { ...INITIALIZE, clientCapabilities: capabilities });
  const created = resultOf(await harness.peer.request('session/new', { cwd: SESSION.cwd, mcpServers: [] })) as { sessionId: string };
  await received(harness, 'the commands are announced', (update) => update.sessionUpdate === 'available_commands_update');
  return created.sessionId;
};

const called = (harness: Harness, prefix: string): Promise<void> =>
  pollUntil(() => harness.runtime.calls.some((call) => call.startsWith(prefix)), { boundMs: 3000, description: `the runtime saw ${prefix}` });

const notices = (harness: Harness) => updatesOf(harness.peer.received).filter((update) => update.sessionUpdate === 'notice');

const untilNotice = (harness: Harness, title: string): Promise<void> => received(harness, `the notice ${title}`, (update) => update.sessionUpdate === 'notice' && update['title'] === title);

const judgementCalls = (harness: Harness): string[] => harness.runtime.calls.filter((call) => call.startsWith('memoryJudgement') || call.startsWith('markMemoryJudgementsShown'));

describe('a memory auto review judged, in an ACP session', () => {
  it('reads the record of the memory, shows its line as one notice, then marks it shown', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await untilNotice(harness, KEPT_LINE);
    await called(harness, 'markMemoryJudgementsShown');

    expect(notices(harness)).toEqual([{ sessionUpdate: 'notice', severity: 'info', title: KEPT_LINE }]);
    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1', 'markMemoryJudgementsShown mem-1']);
    await harness.peer.close();
  });

  it('shows the line of a classifier failure as a warning', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-3', { memoryId: 'mem-3', outcome: 'left', failure: FAILURE, judgedAt: 1, owed: true, closed: false });
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-3'));
    await untilNotice(harness, `auto review left memory mem-3 waiting; ${FAILURE}`);

    expect(notices(harness)).toEqual([{ sessionUpdate: 'notice', severity: 'warning', title: `auto review left memory mem-3 waiting; ${FAILURE}` }]);
    await harness.peer.close();
  });

  it('shows the line as agent text to a client without notices', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    await open(harness, {});

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await received(harness, 'the line as agent text', (update) => JSON.stringify(update).includes(KEPT_LINE));

    const shown = updatesOf(harness.peer.received).filter((update) => JSON.stringify(update).includes(KEPT_LINE));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `momonga info: ${KEPT_LINE}\n` } });
    await harness.peer.close();
  });

  it('shows the line of a record another session already marked shown, then marks it shown again', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept({ owed: false, closed: false }));
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await untilNotice(harness, KEPT_LINE);
    await called(harness, 'markMemoryJudgementsShown');

    expect(notices(harness)).toEqual([{ sessionUpdate: 'notice', severity: 'info', title: KEPT_LINE }]);
    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1', 'markMemoryJudgementsShown mem-1']);
    await harness.peer.close();
  });

  it('shows nothing and marks nothing for a closed record the person decided', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept({ owed: false, closed: true }));
    harness.runtime.judgements.set('mem-2', unsafe);
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await called(harness, 'memoryJudgement mem-1');
    harness.emitSessionEvent(memoryJudgedFrame(9, 'mem-2'));
    await untilNotice(harness, OTHER_LINE);
    await called(harness, 'markMemoryJudgementsShown');

    expect(notices(harness).map((update) => update['title'])).toEqual([OTHER_LINE]);
    expect(harness.runtime.calls.filter((call) => call.startsWith('markMemoryJudgementsShown'))).toEqual(['markMemoryJudgementsShown mem-2']);
    await harness.peer.close();
  });

  it('shows a record at most once in one process, even when it is still owed after the mark', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    harness.runtime.judgements.set('mem-2', unsafe);
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await untilNotice(harness, KEPT_LINE);
    harness.emitSessionEvent(memoryJudgedFrame(9, 'mem-1'));
    harness.emitSessionEvent(memoryJudgedFrame(10, 'mem-2'));
    await untilNotice(harness, OTHER_LINE);

    expect(notices(harness).map((update) => update['title'])).toEqual([KEPT_LINE, OTHER_LINE]);
    await harness.peer.close();
  });

  it('still shows the line when marking it shown fails', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    harness.runtime.failures.set('markMemoryJudgementsShown', new Error('the daemon went away'));
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await untilNotice(harness, KEPT_LINE);
    await called(harness, 'markMemoryJudgementsShown mem-1');

    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1', 'markMemoryJudgementsShown mem-1']);
    await harness.peer.close();
  });

  it('does not read the owed records of the folder when the session stream connects', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    await open(harness);

    harness.emitSessionEvent(modeChangedFrame(8, 'plan'));
    await received(harness, 'the mode change', (update) => update.sessionUpdate === 'current_mode_update');

    expect(harness.sessionStreams).toHaveLength(1);
    expect(harness.runtime.calls.some((call) => call.startsWith('memoryJudgements'))).toBe(false);
    expect(notices(harness)).toEqual([]);
    await harness.peer.close();
  });
});

const isUpdate = (params: unknown, kind: string): boolean => JSON.stringify(params).includes(`"sessionUpdate":"${kind}"`);

const drained = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) await afterMicrotasks();
};

describe('marking a record shown only after its notice was sent', () => {
  it('does not mark the record while the notice has not been sent yet, and marks it once sent', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    await open(harness);
    const held = Promise.withResolvers<void>();
    let noticeStarted = false;
    harness.peer.interceptNotifications(async (_method, params) => {
      if (!isUpdate(params, 'notice')) return;
      noticeStarted = true;
      await held.promise;
    });

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await pollUntil(() => noticeStarted, { boundMs: 3000, description: 'the notice is being sent' });
    await drained();
    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1']);

    held.resolve();
    await untilNotice(harness, KEPT_LINE);
    await called(harness, 'markMemoryJudgementsShown mem-1');
    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1', 'markMemoryJudgementsShown mem-1']);
    await harness.peer.close();
  });

  it('does not mark the record when sending the notice fails, reports the failure once, and keeps the session', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    const sessionId = await open(harness);
    harness.peer.interceptNotifications((_method, params) => {
      if (isUpdate(params, 'notice')) throw new Error('the client refused the notice');
    });

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await called(harness, 'memoryJudgement mem-1');
    await pollUntil(() => harness.reports.length > 0, { boundMs: 3000, description: 'the failed notice is reported' });
    await drained();

    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1']);
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0]).toContain('the client refused the notice');
    expect(harness.reports.some((report) => report.startsWith(`session ${sessionId} failed`))).toBe(false);
    expect(notices(harness)).toEqual([]);
    await harness.peer.close();
  });

  it('does not mark the record when an earlier update of the session already failed to be sent', async () => {
    const harness = startAgent();
    harness.runtime.judgements.set('mem-1', kept());
    await open(harness);
    let modeRefused = false;
    harness.peer.interceptNotifications((_method, params) => {
      if (!isUpdate(params, 'current_mode_update')) return;
      modeRefused = true;
      throw new Error('the client refused the mode update');
    });

    harness.emitSessionEvent(modeChangedFrame(7, 'plan'));
    await pollUntil(() => modeRefused, { boundMs: 3000, description: 'the mode update is refused' });
    await drained();
    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await called(harness, 'memoryJudgement mem-1');
    await drained();

    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1']);
    expect(notices(harness)).toEqual([]);
    await harness.peer.close();
  });
});

const CANON = 'ollama/gemma-3-4b:latest';

const DISPLAY = 'ollama/gemma-3-4b';

const UNCONFIGURED = 'openai/gpt-9';

const WITH_GEMMA = { models: async () => [...MODEL_VIEWS, { canon: CANON, provider: 'ollama', ownName: 'gemma-3-4b:latest', defaultTag: 'latest', naming: 'server' as const }] };

describe('the model of a judgement in an ACP notice is named by its display', () => {
  it.each([
    ['safe with high confidence', kept({ classifier: CANON }), `auto review kept memory mem-1; model ${DISPLAY} judged it safe with high confidence`],
    ['safe without high confidence', kept({ outcome: 'left', confidence: 'low', classifier: CANON }), `auto review left memory mem-1 waiting; model ${DISPLAY} judged it safe without high confidence`],
    ['unsafe', kept({ outcome: 'left', verdict: 'unsafe', classifier: CANON }), `auto review left memory mem-1 waiting; model ${DISPLAY} judged it unsafe`],
    ['a model not among the configured models, as stored', kept({ outcome: 'left', verdict: 'unsafe', classifier: UNCONFIGURED }), `auto review left memory mem-1 waiting; model ${UNCONFIGURED} judged it unsafe`],
    ['a classifier failure, as it is', { memoryId: 'mem-1', outcome: 'left', failure: FAILURE, judgedAt: 1, owed: true, closed: false } as MemoryJudgementView, `auto review left memory mem-1 waiting; ${FAILURE}`],
  ] as const)('shows %s', async (_name, record, line) => {
    const harness = startAgent(WITH_GEMMA);
    harness.runtime.judgements.set('mem-1', record);
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await called(harness, 'markMemoryJudgementsShown mem-1');

    expect(notices(harness).map((update) => update['title'])).toEqual([line]);
    expect(harness.runtime.judgements.get('mem-1')).toEqual(record);
    await harness.peer.close();
  });
});

const GEMMA_VIEW = { canon: CANON, provider: 'ollama', ownName: 'gemma-3-4b:latest', defaultTag: 'latest', naming: 'server' as const };

const KEPT_BY = (model: string): string => `auto review kept memory mem-1; model ${model} judged it safe with high confidence`;

describe('the ACP notice of a judgement when the configured models cannot be read', () => {
  it('sends the notice with the stored model when the agent never managed to list the models, and marks the record shown after it was sent', async () => {
    const harness = startAgent({ models: async () => Promise.reject(new Error('the models could not be read')) });
    harness.runtime.judgements.set('mem-1', kept({ classifier: CANON }));
    await open(harness);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await untilNotice(harness, KEPT_BY(CANON));
    await called(harness, 'markMemoryJudgementsShown mem-1');

    expect(notices(harness)).toEqual([
      { sessionUpdate: 'notice', severity: 'warning', title: 'the model option is not offered because the model list could not be read: the models could not be read' },
      { sessionUpdate: 'notice', severity: 'info', title: KEPT_BY(CANON) },
    ]);
    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1', 'markMemoryJudgementsShown mem-1']);
    await harness.peer.close();
  });

  it('sends the notice with the display of the last good listing when a later listing fails, and marks the record shown after it was sent', async () => {
    let modelsBroken = false;
    let listings = 0;
    const harness = startAgent({
      models: async () => {
        listings += 1;
        if (modelsBroken) throw new Error('the models could not be read');
        return [...MODEL_VIEWS, GEMMA_VIEW];
      },
    });
    harness.runtime.judgements.set('mem-1', kept({ classifier: CANON }));
    const sessionId = await open(harness);
    modelsBroken = true;
    const before = listings;
    await harness.peer.request('session/set_config_option', { sessionId, configId: 'model', value: CANON });
    expect(listings).toBe(before + 1);

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await untilNotice(harness, KEPT_BY(DISPLAY));
    await called(harness, 'markMemoryJudgementsShown mem-1');

    expect(notices(harness)).toEqual([{ sessionUpdate: 'notice', severity: 'info', title: KEPT_BY(DISPLAY) }]);
    expect(judgementCalls(harness)).toEqual(['memoryJudgement mem-1', 'markMemoryJudgementsShown mem-1']);
    await harness.peer.close();
  });

  it('does not read the models while sending the notice', async () => {
    let listings = 0;
    const harness = startAgent({
      models: async () => {
        listings += 1;
        return [...MODEL_VIEWS, GEMMA_VIEW];
      },
    });
    harness.runtime.judgements.set('mem-1', kept({ classifier: CANON }));
    await open(harness);
    const before = listings;

    harness.emitSessionEvent(memoryJudgedFrame(8, 'mem-1'));
    await untilNotice(harness, KEPT_BY(DISPLAY));
    await called(harness, 'markMemoryJudgementsShown mem-1');

    expect(before).toBeGreaterThan(0);
    expect(listings).toBe(before);
    await harness.peer.close();
  });
});
