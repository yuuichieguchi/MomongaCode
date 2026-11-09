import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import type { ContributionPayload, RuntimeStore, TerminalContribution } from '@momonga/store';
import { EXPIRES_MS, awaitingApproval, awaitingInput } from './approval-fixture.ts';
import { DEADLINE_MS, LEASE_MS, START_MS, callEvent, cancel, enqueue, harness, mustClaim, mustRun, newSession, noJournalFacts, payloadOf } from './helpers.ts';
import type { Harness } from './helpers.ts';
import { fakePreparer } from './preparer-fixture.ts';

const preparedHarness = (options: { maxAttempts?: number } = {}) => {
  const fake = fakePreparer();
  const h = harness({ preparer: fake.preparer, ...options });
  fake.bind(h.store);
  return h;
};

const ignoreSweepErrors = (): void => undefined;

const contributionFor = (id: string): ContributionPayload => ({ type: 'context.contribution', items: [{ kind: 'memory', id, contributed: true }] });

type Recording = { hook: TerminalContribution; seen: RunEvent[][] };

const recording = (id = 'm1'): Recording => {
  const seen: RunEvent[][] = [];
  return {
    seen,
    hook: {
      eventTypes: ['user.message'],
      measure: ({ events }) => {
        seen.push([...events]);
        return contributionFor(id);
      },
    },
  };
};

const tailTypes = (store: RuntimeStore, runId: string, count: number): string[] =>
  store
    .readRunEvents(runId, 0, 1000)
    .slice(-count)
    .map((event) => (event.type === 'run.status' ? `run.status:${event.to}` : event.type));

const countOf = (store: RuntimeStore, runId: string): number => store.readRunEvents(runId, 0, 1000).filter((event) => event.type === 'context.contribution').length;

const savedMemory = async (h: Harness, runId: string, callId: string, text: string): Promise<string> => {
  const claim = mustClaim(h.store, 'saver');
  expect(h.store.append(claim, [callEvent(callId)]).kind).toBe('ok');
  const { memory } = await h.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text, runId, step: 1, callId });
  expect((await h.store.release(claim, 'QUEUED')).kind).toBe('ok');
  return memory.id;
};

describe('context.contribution at every terminal transition of the store', () => {
  it.each(['COMPLETED', 'STOPPED', 'FAILED'] as const)('precedes the status of a worker transition to %s', async (to) => {
    const { hook } = recording();
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    expect((await h.store.transition(claim, ['RUNNING'], to, to === 'STOPPED' ? { stopReason: 'max_steps' } : {})).kind).toBe('ok');

    expect(tailTypes(h.store, run.id, 2)).toEqual(['context.contribution', `run.status:${to}`]);
    expect(countOf(h.store, run.id)).toBe(1);
  });

  it('precedes the status when the worker finishes a cancel of a running run', async () => {
    const { hook } = recording();
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    expect((await cancel(h.store, run.id)).status).toBe('CANCELLING');
    expect(countOf(h.store, run.id)).toBe(0);

    expect((await h.store.transition(claim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');

    expect(tailTypes(h.store, run.id, 2)).toEqual(['context.contribution', 'run.status:CANCELLED']);
    expect(countOf(h.store, run.id)).toBe(1);
  });

  it('a cancel of a run that waits for a person withdraws first and reaches CANCELLING; the sweeper finish then writes the contribution before CANCELLED', async () => {
    const h = preparedHarness();
    const { runId } = await awaitingApproval(h.store, [{ callId: 'call_1' }], 'waiting');

    expect((await cancel(h.store, runId)).status).toBe('CANCELLING');
    expect(tailTypes(h.store, runId, 2)).toEqual(['tool.permission.cancelled', 'run.status:CANCELLING']);

    expect(await h.store.finishCancelled(ignoreSweepErrors)).toEqual([runId]);
    expect(tailTypes(h.store, runId, 4)).toEqual(['tool.permission.cancelled', 'run.status:CANCELLING', 'context.contribution', 'run.status:CANCELLED']);
  });

  it('precedes the status when the deadline stops a queued run', async () => {
    const { hook } = recording();
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);

    expect((await h.store.expireApprovals(DEADLINE_MS, (error: unknown) => { throw error; }))).toEqual([run.id]);

    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(tailTypes(h.store, run.id, 2)).toEqual(['context.contribution', 'run.status:STOPPED']);
  });

  it('precedes the status when the deadline stops a run that waits for a person', async () => {
    const { hook } = recording();
    const h = harness({ contribution: hook });
    const { runId } = await awaitingApproval(h.store, [{ callId: 'call_1' }], 'waiting');

    expect((await h.store.expireApprovals(DEADLINE_MS, (error: unknown) => { throw error; }))).toEqual([runId]);

    expect(tailTypes(h.store, runId, 3)).toEqual(['tool.permission.cancelled', 'context.contribution', 'run.status:STOPPED']);
    expect(mustRun(h.store, runId).stopReason).toBe('timeout');
  });

  it('precedes the status when an expired request for input stops the run', async () => {
    const { hook } = recording();
    const h = harness({ contribution: hook });
    const { runId } = await awaitingInput(h.store, [{ callId: 'call_1' }], 'waiting');

    expect((await h.store.expireApprovals(EXPIRES_MS, (error: unknown) => { throw error; }))).toEqual([runId]);

    expect(mustRun(h.store, runId).stopReason).toBe('approval_timeout');
    expect(tailTypes(h.store, runId, 4)).toEqual(['tool.elicitation.cancelled', 'notice', 'context.contribution', 'run.status:STOPPED']);
  });

  it('precedes the status when the dead-letter sweep ends the run', async () => {
    const h = preparedHarness({ maxAttempts: 1 });
    const run = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS);

    expect(h.store.claim('w2')).toBeNull();
    expect(await h.store.deadLetterExhausted(ignoreSweepErrors)).toEqual([run.id]);

    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    expect(tailTypes(h.store, run.id, 2)).toEqual(['context.contribution', 'run.status:FAILED']);
  });

  it('a queued child run that its parent cancels becomes CANCELLING, and its own sweeper finish writes its contribution before CANCELLED', async () => {
    const h = preparedHarness();
    const parent = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w-parent');
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);

    await cancel(h.store, parent.id);

    expect(mustRun(h.store, created.run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    expect(tailTypes(h.store, created.run.id, 1)).toEqual(['run.status:CANCELLING']);
    expect(await h.store.finishCancelled(ignoreSweepErrors)).toEqual([created.run.id]);
    expect(tailTypes(h.store, created.run.id, 2)).toEqual(['context.contribution', 'run.status:CANCELLED']);
  });

  it('does not run the hook for a transition that is not terminal', async () => {
    const { hook, seen } = recording();
    const h = harness({ contribution: hook });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    expect((await h.store.release(claim, 'QUEUED')).kind).toBe('ok');

    expect(seen).toEqual([]);
    expect(countOf(h.store, run.id)).toBe(0);
  });

  it('adds nothing when no hook was given', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    (await h.store.transition(claim, ['RUNNING'], 'COMPLETED'));

    expect(countOf(h.store, run.id)).toBe(0);
  });

  it('adds nothing when the hook finds nothing injected', async () => {
    const h = harness({ contribution: { eventTypes: ['user.message'], measure: () => undefined } });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    (await h.store.transition(claim, ['RUNNING'], 'COMPLETED'));

    expect(tailTypes(h.store, run.id, 1)).toEqual(['run.status:COMPLETED']);
  });
});

describe('measuring over the journal as it stands after the transaction', () => {
  const finalResponse: RunEventPayload = {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  };

  const citing = (seen: RunEvent[][], replayed: string[]): TerminalContribution => ({
    eventTypes: ['model.responded'],
    measure: ({ events, replay }) => {
      seen.push([...events]);
      replay((_state, event) => replayed.push(event.type));
      return contributionFor(events.some((event) => event.type === 'model.responded') ? 'cited' : 'uncited');
    },
  });

  const recordedItems = (store: RuntimeStore, runId: string): unknown[] =>
    store
      .readRunEvents(runId, 0, 1000)
      .flatMap((event) => (event.type === 'context.contribution' ? [event.items] : []))
      .flat();

  it('hands the hook the events that lead the transition and records what they cite', async () => {
    const seen: RunEvent[][] = [];
    const replayed: string[] = [];
    const h = harness({ contribution: citing(seen, replayed) });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    expect((await h.store.transition(claim, ['RUNNING'], 'FAILED', { error: { code: 'input_truncated', message: 'truncated' } }, [finalResponse])).kind).toBe('ok');

    expect(seen.map((events) => events.map((event) => event.type))).toEqual([['model.responded']]);
    expect(replayed).toContain('model.responded');
    expect(recordedItems(h.store, run.id)).toEqual([{ kind: 'memory', id: 'cited', contributed: true }]);
  });
});

describe('the contributed_at stamp', () => {
  it('stamps only the memories that the preparer reports as contributed', async () => {
    let items: ContributionPayload['items'] = [];
    let bound: RuntimeStore | undefined;
    const h = harness({
      preparer: {
        ...noJournalFacts,
        measure: async ({ runId }) => ({ lastSeq: bound?.getRun(runId)?.lastSeq ?? -1, contribution: { type: 'context.contribution', items } }),
      },
    });
    bound = h.store;
    const run = enqueue(h.store, newSession(h.store).id);
    const used = await savedMemory(h, run.id, 'call_1', 'used note');
    const unused = await savedMemory(h, run.id, 'call_2', 'unused note');
    const claim = mustClaim(h.store, 'w2');
    items = [
      { kind: 'memory', id: used, contributed: true },
      { kind: 'memory', id: unused, contributed: false },
      { kind: 'summary', id: 'summary-9', contributed: true },
    ];

    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(countOf(h.store, run.id)).toBe(1);
    expect(h.store.memories.get(used)?.contributedAt).toBe(START_MS);
    expect(h.store.memories.get(unused)?.contributedAt).toBeNull();
  });

  it.each(['STOPPED', 'FAILED'] as const)('leaves contributed_at empty for a run that ends %s, though its terminal records the memory as contributed', async (to) => {
    let named = '';
    const h = harness({ contribution: { eventTypes: ['user.message'], measure: () => contributionFor(named) } });
    const run = enqueue(h.store, newSession(h.store).id);
    const id = await savedMemory(h, run.id, 'call_1', 'used note');
    named = id;
    const claim = mustClaim(h.store, 'w2');

    expect((await h.store.transition(claim, ['RUNNING'], to, to === 'STOPPED' ? { stopReason: 'max_steps' } : {})).kind).toBe('ok');

    expect(h.store.readRunEvents(run.id, 0, 1000).flatMap((event) => (event.type === 'context.contribution' ? event.items : []))).toEqual([{ kind: 'memory', id, contributed: true }]);
    expect(h.store.memories.get(id)?.contributedAt).toBeNull();
  });

  it('stamps the memory named by the event the hook supplied when the run completes', async () => {
    let named = '';
    const h = harness({ contribution: { eventTypes: ['user.message'], measure: () => contributionFor(named) } });
    const run = enqueue(h.store, newSession(h.store).id);
    named = await savedMemory(h, run.id, 'call_1', 'used note');
    const claim = mustClaim(h.store, 'w2');
    h.clock.advance(7);

    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(countOf(h.store, run.id)).toBe(1);
    expect(h.store.memories.get(named)?.contributedAt).toBe(START_MS + 7);
  });

  it('moves contributed_at to the terminal time of a later run that contributed again', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const id = await savedMemory(h, run.id, 'call_1', 'used note');

    h.store.memories.stampContributed([id], START_MS + 3);
    h.store.memories.stampContributed([id, 'unknown-id'], START_MS + 10);

    expect(h.store.memories.get(id)?.contributedAt).toBe(START_MS + 10);
  });

  it('keeps the later time when an earlier run is stamped again, and when the same run is stamped twice', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const id = await savedMemory(h, run.id, 'call_1', 'used note');
    h.store.memories.stampContributed([id], START_MS + 10);

    h.store.memories.stampContributed([id], START_MS + 3);
    expect(h.store.memories.get(id)?.contributedAt).toBe(START_MS + 10);
    h.store.memories.stampContributed([id], START_MS + 10);
    expect(h.store.memories.get(id)?.contributedAt).toBe(START_MS + 10);
  });

  it('stamps a memory again with the terminal time of each completed run that contributed', async () => {
    let named = '';
    const h = harness({ contribution: { eventTypes: ['user.message'], measure: () => contributionFor(named) } });
    const first = enqueue(h.store, newSession(h.store).id);
    named = await savedMemory(h, first.id, 'call_1', 'used note');
    h.clock.advance(5);
    expect((await h.store.transition(mustClaim(h.store, 'w2'), ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    expect(h.store.memories.get(named)?.contributedAt).toBe(START_MS + 5);
    h.clock.advance(20);
    enqueue(h.store, newSession(h.store).id);

    expect((await h.store.transition(mustClaim(h.store, 'w3'), ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(h.store.memories.get(named)?.contributedAt).toBe(START_MS + 25);
  });
});

describe('lastTerminalRootRuns', () => {
  const finish = async (h: Harness, cwd: string, started = true): Promise<string> => {
    h.clock.advance(1);
    const run = enqueue(h.store, newSession(h.store, cwd).id);
    const claim = mustClaim(h.store, `w-${run.id}`);
    if (started) expect(h.store.append(claim, [{ type: 'run.started', attempt: 1, now: h.clock.now(), pins: {} }]).kind).toBe('ok');
    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    return run.id;
  };

  it('returns the newest terminal root runs of one project that started, up to the limit', async () => {
    const h = harness();
    const first = await finish(h, '/work/a');
    await finish(h, '/work/b');
    const second = await finish(h, '/work/a');
    await finish(h, '/work/a', false);
    const third = await finish(h, '/work/a');

    expect(h.store.lastTerminalRootRuns('/work/a', 10).map((run) => run.id)).toEqual([third, second, first]);
    expect(h.store.lastTerminalRootRuns('/work/a', 2).map((run) => run.id)).toEqual([third, second]);
  });

  it('leaves out runs that are not terminal and child runs', async () => {
    const h = harness();
    const done = await finish(h, '/work/a');
    const parent = enqueue(h.store, newSession(h.store, '/work/a').id);
    const claim = mustClaim(h.store, 'w-parent');
    expect(h.store.append(claim, [{ type: 'run.started', attempt: 1, now: h.clock.now(), pins: {} }]).kind).toBe('ok');
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);

    expect(h.store.lastTerminalRootRuns('/work/a', 10).map((run) => run.id)).toEqual([done]);
  });
});

describe('notice codes', () => {
  it('stores a stable code and still decodes a notice that has none', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    expect(
      h.store.append(claim, [
        { type: 'notice', level: 'warning', message: 'with a code', code: 'memories_dropped' },
        { type: 'notice', level: 'warning', message: 'without a code' },
      ]).kind,
    ).toBe('ok');

    expect(h.store.readRunEventsOfTypes(run.id, ['notice']).map(payloadOf)).toEqual([
      { type: 'notice', level: 'warning', message: 'with a code', code: 'memories_dropped' },
      { type: 'notice', level: 'warning', message: 'without a code' },
    ]);
  });
});
