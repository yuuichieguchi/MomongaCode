import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { JournalThreadError, StalePreparation, createJournalReader } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { EXPIRES_MS, awaitingInput } from './approval-fixture.ts';
import { LEASE_MS, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';
import { contributionOf, fakePreparer } from './preparer-fixture.ts';
import type { FakePreparer, Reply } from './preparer-fixture.ts';

const finalResponse: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
};

const typesOf = (store: RuntimeStore, runId: string): string[] =>
  store.readRunEvents(runId, 0, 1000).map((event) => (event.type === 'run.status' ? `run.status:${event.to}` : event.type));

const contributionsOf = (store: RuntimeStore, runId: string) =>
  store.readRunEvents(runId, 0, 1000).filter((event) => event.type === 'context.contribution').map((event) => (event.type === 'context.contribution' ? event.items : []));

const withPreparer = (replies: Reply[] = [], options: { maxAttempts?: number; maxTotalAttempts?: number } = {}) => {
  const fake: FakePreparer = fakePreparer(replies);
  const h = harness({ preparer: fake.preparer, ...options });
  fake.bind(h.store);
  return { ...h, fake };
};

describe('the port of the store (ContributionPreparer, StalePreparation, JournalThreadError, createJournalReader)', () => {
  it('exports the stale refusal and the thread failure as errors, and the journal reader as a function', async () => {
    expect(new StalePreparation('run-1')).toBeInstanceOf(Error);
    expect(new JournalThreadError('the journal thread exited')).toBeInstanceOf(Error);
    expect(new JournalThreadError('the journal thread exited').name).toBe('JournalThreadError');
    expect(typeof createJournalReader).toBe('function');
  });

  it('has no prepareTerminal: a caller can no longer measure ahead of the operation', async () => {
    const { store } = withPreparer();
    expect('prepareTerminal' in store).toBe(false);
  });
});

describe('a worker terminal is one operation: plan, await the preparer, commit', () => {
  it('returns a promise and commits the measured contribution immediately before run.status, asking the preparer once with the run and no leading events', async () => {
    const h = withPreparer();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    const pending = h.store.transition(claim, ['RUNNING'], 'COMPLETED');

    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).kind).toBe('ok');
    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:COMPLETED']);
    expect(contributionsOf(h.store, run.id)).toEqual([contributionOf('m1').items]);
    expect(h.fake.requests).toEqual([{ runId: run.id, leading: [] }]);
  });

  it('hands the preparer the preceding events as its leading events and appends exactly those before the contribution', async () => {
    const h = withPreparer();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    expect((await h.store.transition(claim, ['RUNNING'], 'FAILED', { error: { code: 'input_truncated', message: 'truncated' } }, [finalResponse])).kind).toBe('ok');

    expect(h.fake.requests).toEqual([{ runId: run.id, leading: [finalResponse] }]);
    expect(typesOf(h.store, run.id).slice(-3)).toEqual(['model.responded', 'context.contribution', 'run.status:FAILED']);
  });

  it('CommitRefuseStale: a measurement of an older lastSeq writes nothing, and the operation measures again and commits the fresh one', async () => {
    const h = withPreparer([{ kind: 'stale', id: 'old' }, { kind: 'fresh', id: 'new' }]);
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const before = typesOf(h.store, run.id);
    const seenAtSecondCall: string[][] = [];
    h.fake.during(async (_request, call) => {
      if (call === 2) seenAtSecondCall.push(typesOf(h.store, run.id));
    });

    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(h.fake.requests).toHaveLength(2);
    expect(seenAtSecondCall).toEqual([before]);
    expect(contributionsOf(h.store, run.id)).toEqual([contributionOf('new').items]);
    expect(mustRun(h.store, run.id).status).toBe('COMPLETED');
  });

  it('a failed measurement rejects the operation with the thread error and writes nothing: no event, no status change, the lease still held', async () => {
    const failure = new JournalThreadError('the journal thread exited');
    const h = withPreparer([{ kind: 'fail', error: failure }]);
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const before = typesOf(h.store, run.id);

    await expect(h.store.transition(claim, ['RUNNING'], 'COMPLETED')).rejects.toBe(failure);

    expect(typesOf(h.store, run.id)).toEqual(before);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'RUNNING', leaseOwner: 'w1' });
    expect(h.store.heartbeat(claim).kind).toBe('ok');
  });

  it('a lease lost while the measurement is awaited ends in lease_lost before anything is written', async () => {
    const h = withPreparer();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const before = typesOf(h.store, run.id);
    h.fake.during(async () => {
      h.clock.advance(LEASE_MS + 1);
      mustClaim(h.store, 'w2');
    });

    expect(await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });

    expect(typesOf(h.store, run.id).filter((type) => !before.includes(type))).toEqual(['attempt.lost']);
    expect(contributionsOf(h.store, run.id)).toEqual([]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'RUNNING', leaseOwner: 'w2' });
  });

  it('a cancel that lands during the wait refuses the finish; the cancel finish of the same holder then measures again and commits', async () => {
    const h = withPreparer();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.fake.during(async (_request, call) => {
      if (call === 1) expect(await h.store.requestCancel(run.id)).toMatchObject({ kind: 'ok', run: { status: 'CANCELLING' } });
    });

    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('conflict');
    expect((await h.store.transition(claim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');

    expect(h.fake.requests.length).toBeGreaterThanOrEqual(2);
    expect(contributionsOf(h.store, run.id)).toHaveLength(1);
    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:CANCELLED']);
  });

  it('a store with no preparer commits a terminal with no contribution and no error', async () => {
    const h = harness();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(typesOf(h.store, run.id)).not.toContain('context.contribution');
    expect(mustRun(h.store, run.id).status).toBe('COMPLETED');
  });

  it('measures nothing for a transition that is not terminal', async () => {
    const h = withPreparer();
    await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    expect((await h.store.transition(claim, ['RUNNING'], 'WAITING_TOOL')).kind).toBe('ok');

    expect(h.fake.requests).toEqual([]);
  });
});

describe('approval expiry is an operation that awaits the preparer', () => {
  it('expireApprovals returns a promise and hands the preparer the expiry and the notice as leading events, which precede the contribution', async () => {
    const h = withPreparer();
    const { runId } = await awaitingInput(h.store, [{ callId: 'call_1' }], 'waiting');

    const pending = h.store.expireApprovals(EXPIRES_MS, (error: unknown) => { throw error; });

    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual([runId]);
    expect(h.fake.requests.map((request) => request.leading.map((event) => event.type))).toEqual([['tool.elicitation.cancelled', 'notice']]);
    expect(typesOf(h.store, runId).slice(-4)).toEqual(['tool.elicitation.cancelled', 'notice', 'context.contribution', 'run.status:STOPPED']);
  });
});

describe('one writer of context.contribution (O12)', () => {
  it('store.append refuses a context.contribution event and the journal is unchanged', async () => {
    const h = withPreparer();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const before = typesOf(h.store, run.id);

    expect(() => h.store.append(claim, [contributionOf('m1')])).toThrow(/context\.contribution/);

    expect(typesOf(h.store, run.id)).toEqual(before);
  });
});

describe('the commit never measures (P4)', () => {
  it('the store calls no measure other than the preparer port, and keeps no inline measurement', async () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'runtime-store.ts'), 'utf8');
    const measureCalls = [...source.matchAll(/([\w.]+)\.measure\(/g)].map((match) => match[1]);
    expect(measureCalls.length).toBeGreaterThan(0);
    expect(measureCalls.filter((name) => !/(^|\.)preparer$/.test(name ?? ''))).toEqual([]);
    expect(source).not.toMatch(/measureContribution|prepareTerminal|journaled/);
  });
});
