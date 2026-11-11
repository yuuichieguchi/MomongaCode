import { describe, expect, it } from 'vitest';
import { DATASET_FORMAT, EvalError, runDataset } from '@momonga/eval';
import type { EvalRunApi } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { approvalTranscript, callsTranscript, finalAnswerTranscript, goldenCase, publicEventsOf } from './fixtures.ts';
import type { RecordedRun, Transcript } from '@momonga/eval';

type Scripted = { sessions: string[]; runs: string[]; resolved: { approvalId: string; optionId: string }[]; cancelled: string[]; api: EvalRunApi };

const scriptedApi = (transcripts: Transcript[]): Scripted => {
  const record: Scripted = { sessions: [], runs: [], resolved: [], cancelled: [], api: undefined as unknown as EvalRunApi };
  const byRun = new Map(transcripts.map((transcript) => [transcript.run.id, transcript]));
  const childEvents = new Map(transcripts.flatMap((transcript) => transcript.children.map((child) => [child.runId, child.events] as const)));
  const queue = [...transcripts];
  record.api = {
    costs: async () => [],
    createSession: async (input) => {
      record.sessions.push(input.permissionMode);
      return { id: `s${record.sessions.length}` };
    },
    createRun: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted run left');
      record.runs.push(next.run.id);
      return { id: next.run.id };
    },
    events: async function* (runId) {
      for (const event of byRun.get(runId)?.events ?? childEvents.get(runId) ?? []) yield event;
    },
    reflectionOf: async () => ({ state: 'none' }),
    answeredBy: async () => [],
    getRun: async (runId) => {
      const found = byRun.get(runId);
      if (found === undefined) throw new Error(`unknown run ${runId}`);
      return found.run;
    },
    resolveApproval: async (approvalId, optionId) => {
      record.resolved.push({ approvalId, optionId });
    },
    cancelRun: async (runId) => {
      record.cancelled.push(runId);
    },
  };
  return record;
};

const shared = (api: EvalRunApi) => ({ open: async () => ({ api, workspace: { cwd: '/w', env: { HOME: '/h' } }, close: async () => undefined }) });

describe('runDataset', () => {
  it('runs every case N times in a fresh session and reports the pass rate', async () => {
    const scripted = scriptedApi([finalAnswerTranscript('answer', 0), finalAnswerTranscript('answer', 1), finalAnswerTranscript('answer', 2)]);
    const stored: string[] = [];
    const report = await runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'answer', runs: 3, graders: [{ kind: 'finalTextEquals', text: 'hi' }] })] },
      { ...shared(scripted.api), onTranscript: async (transcript) => void stored.push(`${transcript.caseId}.${transcript.runIndex}`) },
    );
    expect(scripted.sessions).toEqual(['manual', 'manual', 'manual']);
    expect(stored).toEqual(['answer.0', 'answer.1', 'answer.2']);
    expect(report.cases[0]?.passRate).toMatchObject({ successes: 3, trials: 3 });
    expect(report.passed).toBe(true);
  });

  it('answers an approval request with the option of the configured kind', async () => {
    const scripted = scriptedApi([approvalTranscript('ask', 0)]);
    await runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'ask', onAsk: 'reject_once', graders: [{ kind: 'permissionDecision', tool: 'Bash', expected: 'ask' }] })] },
      shared(scripted.api),
    );
    expect(scripted.resolved).toEqual([{ approvalId: 'a1', optionId: 'reject_once' }]);
  });

  it('fails when the approval offers no option of the configured kind', async () => {
    const transcript = approvalTranscript('ask', 0);
    const events = transcript.events.map((event) =>
      event.type === 'tool.permission.requested' ? { ...event, options: event.options.filter((option) => option.kind !== 'allow_once') } : event,
    );
    const scripted = scriptedApi([{ ...transcript, events }]);
    await expect(
      runDataset(
        { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'ask', onAsk: 'allow_once', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
        shared(scripted.api),
      ),
    ).rejects.toThrow(EvalError);
  });

  describe('a run that asks about a call whose effect is unknown', () => {
    const asking = (): Transcript => {
      const transcript = finalAnswerTranscript('answer', 0);
      const ask = {
        ...(transcript.events[0] as PublicRunEvent),
        type: 'tool.unknown.requested',
        approvalId: 'u1',
        callIds: ['c1'],
        options: [{ optionId: 'allow_once', name: 'Continue', kind: 'allow_once' }],
        subjectDigest: 'd',
      } as unknown as PublicRunEvent;
      return { ...transcript, events: [ask, ...transcript.events] };
    };

    it('is continued when the case answers asks with allow_once', async () => {
      const scripted = scriptedApi([asking()]);
      await runDataset({ format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'answer', onAsk: 'allow_once', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] }, shared(scripted.api));
      expect(scripted.resolved).toEqual([{ approvalId: 'u1', optionId: 'allow_once' }]);
      expect(scripted.cancelled).toEqual([]);
    });

    it('is cancelled when the case answers asks with reject_once, and the trial is graded as it ended', async () => {
      const scripted = scriptedApi([asking()]);
      const report = await runDataset({ format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'answer', onAsk: 'reject_once', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] }, shared(scripted.api));
      expect(scripted.resolved).toEqual([]);
      expect(scripted.cancelled).toEqual(['run-answer-0']);
      expect(report.cases).toHaveLength(1);
    });
  });

  it('follows a subagent run announced by tool.waiting and answers its approval requests', async () => {
    const parent = callsTranscript('delegate', [{ callId: 'agent1', name: 'Agent', kind: 'other', sideEffect: 'read_only', rawInput: {}, decision: 'allow' }]);
    const waiting = { ...(parent.events[0] as PublicRunEvent), type: 'tool.waiting', callId: 'agent1', awaits: { kind: 'run', runId: 'child-1', sessionId: 's-child', agent: 'writer' } } as unknown as PublicRunEvent;
    const withChild: Transcript = {
      ...parent,
      events: [...parent.events, waiting],
      children: [{ runId: 'child-1', agent: 'writer', events: callsTranscript('child', [{ callId: 'w1', name: 'Write', kind: 'edit', rawInput: { file_path: '/w/.zshrc' }, decision: 'ask' }]).events }],
    };
    const scripted = scriptedApi([withChild]);
    let recorded: RecordedRun | undefined;
    const report = await runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'delegate', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] })] },
      {
        ...shared(scripted.api),
        onTranscript: async (transcript) => {
          recorded = transcript;
        },
      },
    );
    expect(scripted.resolved).toEqual([{ approvalId: 'a-w1', optionId: 'reject_once' }]);
    expect(recorded?.children.map((child) => [child.runId, child.agent])).toEqual([['child-1', 'writer']]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 0, trials: 1 });
    expect(report.passed).toBe(true);
  });

  describe('a subagent follower that fails while the root run is still open', () => {
    const delegating = () => {
      const parent = callsTranscript('delegate', [{ callId: 'agent1', name: 'Agent', kind: 'other', sideEffect: 'read_only', rawInput: {}, decision: 'allow' }]);
      const waiting = { ...(parent.events[0] as PublicRunEvent), type: 'tool.waiting', callId: 'agent1', awaits: { kind: 'run', runId: 'child-1', sessionId: 's-child', agent: 'writer' } } as unknown as PublicRunEvent;
      const childEvents = callsTranscript('child', [{ callId: 'w1', name: 'Write', kind: 'edit', rawInput: {}, decision: 'ask' }]).events;
      return { parent, waiting, childEvents };
    };

    const failuresOf = (rejection: unknown): readonly unknown[] => {
      const cause = (rejection as EvalError).cause;
      if (!(cause instanceof AggregateError)) throw new Error('expected an AggregateError cause');
      return cause.errors;
    };

    it('cancels the root run and stops waiting when the root follower itself fails', async () => {
      const parent = callsTranscript('delegate', [{ callId: 'w0', name: 'Write', kind: 'edit', rawInput: {}, decision: 'ask' }]);
      const scripted = scriptedApi([parent]);
      const rootCancelled = Promise.withResolvers<void>();
      const failure = new Error('approval endpoint unreachable');
      const api: EvalRunApi = {
        ...scripted.api,
        events: async function* () {
          for (const event of parent.events) yield event;
          await rootCancelled.promise;
        },
        resolveApproval: async () => {
          throw failure;
        },
        cancelRun: async (runId) => {
          scripted.cancelled.push(runId);
          rootCancelled.resolve();
        },
      };
      await expect(
        runDataset({ format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'delegate', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] }, shared(api)),
      ).rejects.toBe(failure);
      expect(scripted.cancelled).toEqual([parent.run.id]);
    });

    it('surfaces the original follower failure together with the error the cancel provoked on the root stream', async () => {
      const { parent, waiting, childEvents } = delegating();
      const scripted = scriptedApi([parent]);
      const failure = new Error('approval endpoint unreachable');
      const derived = new Error('root stream closed by cancel');
      const rootCancelled = Promise.withResolvers<void>();
      const api: EvalRunApi = {
        ...scripted.api,
        events: async function* (runId) {
          if (runId === 'child-1') {
            for (const event of childEvents) yield event;
            return;
          }
          for (const event of [...parent.events, waiting]) yield event;
          await rootCancelled.promise;
          throw derived;
        },
        resolveApproval: async () => {
          throw failure;
        },
        cancelRun: async () => {
          rootCancelled.resolve();
        },
      };
      const rejection = await runDataset(
        { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'delegate', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
        shared(api),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(EvalError);
      expect(failuresOf(rejection)).toEqual([failure, derived]);
    });

    it('cancels the root run at once instead of waiting for the root stream to end by itself', async () => {
      const { parent, waiting, childEvents } = delegating();
      const scripted = scriptedApi([parent]);
      const rootCancelled = Promise.withResolvers<void>();
      const failure = new Error('approval endpoint unreachable');
      const api: EvalRunApi = {
        ...scripted.api,
        events: async function* (runId) {
          if (runId === 'child-1') {
            for (const event of childEvents) yield event;
            return;
          }
          for (const event of [...parent.events, waiting]) yield event;
          await rootCancelled.promise;
        },
        resolveApproval: async () => {
          throw failure;
        },
        cancelRun: async (runId) => {
          scripted.cancelled.push(runId);
          rootCancelled.resolve();
        },
      };
      await expect(
        runDataset({ format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'delegate', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] }, shared(api)),
      ).rejects.toBe(failure);
      expect(scripted.cancelled).toEqual([parent.run.id]);
    });

    it('reports a failed cancellation together with the follower failure that caused it', async () => {
      const { parent, waiting, childEvents } = delegating();
      const scripted = scriptedApi([parent]);
      const failure = new Error('approval endpoint unreachable');
      const api: EvalRunApi = {
        ...scripted.api,
        events: async function* (runId) {
          for (const event of runId === 'child-1' ? childEvents : [...parent.events, waiting]) yield event;
        },
        resolveApproval: async () => {
          throw failure;
        },
        cancelRun: async () => {
          throw new Error('cancel refused');
        },
      };
      const rejection = await runDataset(
        { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'delegate', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
        shared(api),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(EvalError);
      expect((rejection as EvalError).message).toContain('cancel refused');
      expect(failuresOf(rejection)).toContain(failure);
    });

    it('leaves no unhandled rejection when the cancel fails while the root stream is still open', async () => {
      const { parent, waiting, childEvents } = delegating();
      const scripted = scriptedApi([parent]);
      const failure = new Error('approval endpoint unreachable');
      const cancelFailed = Promise.withResolvers<void>();
      const unhandled: unknown[] = [];
      const recordUnhandled = (reason: unknown): void => void unhandled.push(reason);
      const nodeReportedUnhandledRejections = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
      const api: EvalRunApi = {
        ...scripted.api,
        events: async function* (runId) {
          if (runId === 'child-1') {
            for (const event of childEvents) yield event;
            return;
          }
          for (const event of [...parent.events, waiting]) yield event;
          await cancelFailed.promise;
          await nodeReportedUnhandledRejections();
        },
        resolveApproval: async () => {
          throw failure;
        },
        cancelRun: async () => {
          cancelFailed.resolve();
          throw new Error('cancel refused');
        },
      };
      process.on('unhandledRejection', recordUnhandled);
      try {
        const rejection = await runDataset(
          { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'delegate', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
          shared(api),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        await nodeReportedUnhandledRejections();
        expect(unhandled).toEqual([]);
        expect(rejection).toBeInstanceOf(EvalError);
        expect((rejection as EvalError).message).toContain('cancel refused');
        expect(failuresOf(rejection)).toContain(failure);
      } finally {
        process.off('unhandledRejection', recordUnhandled);
      }
    });

    it('waits for the other followers before reporting that the root stream broke', async () => {
      const { parent, waiting } = delegating();
      const scripted = scriptedApi([parent]);
      const childMayFinish = Promise.withResolvers<void>();
      const rootFailure = new Error('root stream broke');
      const finished: string[] = [];
      const api: EvalRunApi = {
        ...scripted.api,
        events: async function* (runId) {
          if (runId === 'child-1') {
            await childMayFinish.promise;
            finished.push('child');
            return;
          }
          for (const event of [...parent.events, waiting]) yield event;
          throw rootFailure;
        },
      };
      const outcome = runDataset(
        { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'delegate', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
        shared(api),
      ).then(
        () => 'resolved',
        (error: unknown) => {
          finished.push('reported');
          return error;
        },
      );
      const nodeTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
      await nodeTurn();
      expect(finished).toEqual([]);
      childMayFinish.resolve();
      expect(await outcome).toBe(rootFailure);
      expect(finished).toEqual(['child', 'reported']);
    });
  });

  it('lets an infrastructure failure propagate', async () => {
    const scripted = scriptedApi([]);
    await expect(
      runDataset({ format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'answer', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] }, shared(scripted.api)),
    ).rejects.toThrow('no scripted run left');
  });
});

describe('a mandate run that went quiescent, driven by a runner without a person', () => {
  const HELD = { callId: 'c1', approvalId: 'held-1', tool: 'GitPush', reason: 'needs a person', sinceSeq: 3 };
  const heldEvents = publicEventsOf([
    { type: 'user.message', text: 'push it' },
    { type: 'tool.held', callId: 'c1', approvalId: 'held-1', reason: 'needs a person', footprint: { reads: [], writes: [] } },
    { type: 'run.quiescent', held: [HELD, { ...HELD, callId: 'c2', approvalId: 'held-2' }] },
  ]);
  const resumedEvents = publicEventsOf([{ type: 'tool.held.resolved', callId: 'c1', approvalId: 'held-1', outcome: 'rejected', status: 'failed', output: 'rejected' }]);

  const heldApi = (): { resolved: { approvalId: string; optionId: string }[]; cancelled: string[]; api: EvalRunApi } => {
    const answered = Promise.withResolvers<void>();
    const record = { resolved: [] as { approvalId: string; optionId: string }[], cancelled: [] as string[], api: undefined as unknown as EvalRunApi };
    record.api = {
      costs: async () => [],
      createSession: async () => ({ id: 's1' }),
      createRun: async () => ({ id: 'run-held' }),
      events: async function* () {
        for (const event of heldEvents) yield event;
        await answered.promise;
        for (const event of resumedEvents) yield event;
      },
      reflectionOf: async () => ({ state: 'none' }),
      answeredBy: async () => [],
      getRun: async (runId) => ({ id: runId, status: record.resolved.length === 2 ? 'COMPLETED' : 'WAITING_HUMAN', step: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
      resolveApproval: async (approvalId, optionId) => {
        record.resolved.push({ approvalId, optionId });
        if (record.resolved.length === 2) answered.resolve();
      },
      cancelRun: async (runId) => {
        record.cancelled.push(runId);
      },
    };
    return record;
  };

  it('resolves every held approval as its onAsk says, so the run goes on to its end', async () => {
    const held = heldApi();
    const stored: RecordedRun[] = [];

    await runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'held', onAsk: 'reject_once', mandate: { scope: { allow: ['Read'] }, hold: { onQuiescent: 'wait' } }, graders: [{ kind: 'mustNotRun', tool: 'GitPush' }] })] },
      { ...shared(held.api), onTranscript: async (transcript) => void stored.push(transcript) },
    );

    expect(held.resolved).toEqual([
      { approvalId: 'held-1', optionId: 'reject_once' },
      { approvalId: 'held-2', optionId: 'reject_once' },
    ]);
    expect(stored[0]?.run.status).toBe('COMPLETED');
    expect(stored[0]?.events.at(-1)?.type).toBe('tool.held.resolved');
  });

  it('ends the trial with the run still held when the case says a quiescent run reports and stops', async () => {
    const held = heldApi();
    const stored: RecordedRun[] = [];

    await runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'held', onAsk: 'reject_once', mandate: { scope: { allow: ['Read'] }, hold: { onQuiescent: 'report' } }, graders: [{ kind: 'mustNotRun', tool: 'GitPush' }] })] },
      { ...shared(held.api), onTranscript: async (transcript) => void stored.push(transcript) },
    );

    expect(held.resolved).toEqual([]);
    expect(held.cancelled).toEqual([]);
    expect(stored[0]?.run.status).toBe('WAITING_HUMAN');
    expect(stored[0]?.events.at(-1)?.type).toBe('run.quiescent');
  });
});
