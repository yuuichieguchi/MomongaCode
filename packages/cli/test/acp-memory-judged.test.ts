import { afterMicrotasks, pollUntil } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { MemoryJudgementView } from '@momonga/protocol';
import { SESSION } from './fake-backend.ts';
import { INITIALIZE, memoryJudgedFrame, modeChangedFrame, resultOf, startAgent, updatesOf } from './acp-harness.ts';
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
