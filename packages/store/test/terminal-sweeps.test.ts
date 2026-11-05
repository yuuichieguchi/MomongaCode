import { describe, expect, it } from 'vitest';
import { JournalThreadError } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { awaitingApproval } from './approval-fixture.ts';
import { LEASE_MS, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';
import { contributionOf, fakePreparer } from './preparer-fixture.ts';
import type { Reply } from './preparer-fixture.ts';

const withPreparer = (replies: Reply[] = [], options: { maxAttempts?: number; maxTotalAttempts?: number } = {}) => {
  const fake = fakePreparer(replies);
  const h = harness({ preparer: fake.preparer, ...options });
  fake.bind(h.store);
  return { ...h, fake };
};

const typesOf = (store: RuntimeStore, runId: string): string[] =>
  store.readRunEvents(runId, 0, 1000).map((event) => (event.type === 'run.status' ? `run.status:${event.to}` : event.type));

type Reported = { error: unknown; runId: string };

const reporter = () => {
  const reported: Reported[] = [];
  return { reported, onError: (error: unknown, runId: string) => void reported.push({ error, runId }) };
};

describe('the sweeper-owned finish of a cancelled run that never ran (finishCancelled)', () => {
  it('ends a run cancelled while QUEUED as CANCELLED with its contribution, clears the cancel origin, and measures that run only', async () => {
    const h = withPreparer();
    const run = enqueue(h.store, newSession(h.store).id);
    h.store.requestCancel(run.id);
    const { reported, onError } = reporter();

    const pending = h.store.finishCancelled(onError);

    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual([run.id]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'CANCELLED', cancelOrigin: null, deadLetter: false, leaseOwner: null });
    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:CANCELLED']);
    expect(h.fake.requests).toEqual([{ runId: run.id, leading: [] }]);
    expect(reported).toEqual([]);
  });

  it('ends a run cancelled while WAITING_HUMAN as CANCELLED', async () => {
    const h = withPreparer();
    const { runId } = awaitingApproval(h.store, [{ callId: 'call_1' }], 'waiting');
    h.store.requestCancel(runId);

    expect(await h.store.finishCancelled(reporter().onError)).toEqual([runId]);

    expect(mustRun(h.store, runId).status).toBe('CANCELLED');
    expect(h.store.approvals.listPending(runId)).toEqual([]);
  });

  it('leaves a run cancelled while RUNNING to its holder or a claim', async () => {
    const h = withPreparer();
    const run = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    h.store.requestCancel(run.id);
    h.clock.advance(LEASE_MS + 1);

    expect(await h.store.finishCancelled(reporter().onError)).toEqual([]);

    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'RUNNING' });
    expect(h.fake.requests).toEqual([]);
  });

  it('reports a thread failure for one run with its id, leaves that run CANCELLING and unchanged, finishes the others, and finishes it at the next sweep', async () => {
    const failure = new JournalThreadError('the journal thread exited');
    const h = withPreparer([{ kind: 'fail', error: failure }]);
    const first = enqueue(h.store, newSession(h.store, '/work/a').id);
    const second = enqueue(h.store, newSession(h.store, '/work/b').id);
    h.store.requestCancel(first.id);
    h.store.requestCancel(second.id);
    const before = typesOf(h.store, first.id);
    const { reported, onError } = reporter();

    expect(await h.store.finishCancelled(onError)).toEqual([second.id]);

    expect(reported).toEqual([{ error: failure, runId: first.id }]);
    expect(typesOf(h.store, first.id)).toEqual(before);
    expect(mustRun(h.store, first.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    expect(mustRun(h.store, second.id).status).toBe('CANCELLED');

    expect(await h.store.finishCancelled(onError)).toEqual([first.id]);
    expect(mustRun(h.store, first.id).status).toBe('CANCELLED');
    expect(reported).toHaveLength(1);
  });
});

describe('dead-lettering has one owner, the sweep (O7); claim only claims', () => {
  it('claim neither returns nor dead-letters an exhausted run, stays synchronous and never asks the preparer', () => {
    const h = withPreparer([], { maxAttempts: 1 });
    const run = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS);

    const claimed = h.store.claim('w2');

    expect(claimed).toBeNull();
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'RUNNING', deadLetter: false });
    expect(typesOf(h.store, run.id)).not.toContain('context.contribution');
    expect(h.fake.requests).toEqual([]);
  });

  it('deadLetterExhausted ends the exhausted run FAILED as a dead letter with its contribution before the status', async () => {
    const h = withPreparer([], { maxAttempts: 1 });
    const run = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS);
    const { reported, onError } = reporter();

    const pending = h.store.deadLetterExhausted(onError);

    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual([run.id]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:FAILED']);
    expect(h.fake.requests).toEqual([{ runId: run.id, leading: [] }]);
    expect(reported).toEqual([]);
  });

  it('reports a thread failure per run and retries it at the next sweep', async () => {
    const failure = new JournalThreadError('the journal thread exited');
    const h = withPreparer([{ kind: 'fail', error: failure }], { maxAttempts: 1 });
    const run = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS);
    const { reported, onError } = reporter();

    expect(await h.store.deadLetterExhausted(onError)).toEqual([]);
    expect(reported).toEqual([{ error: failure, runId: run.id }]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'RUNNING', deadLetter: false });

    expect(await h.store.deadLetterExhausted(onError)).toEqual([run.id]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
  });

  it('never dead-letters a sweeper-owned run, even when its attempts are spent; the cancel finish ends it CANCELLED', async () => {
    const h = withPreparer([], { maxAttempts: 1, maxTotalAttempts: 1 });
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    expect(h.store.release(claim, 'QUEUED').kind).toBe('ok');
    h.store.requestCancel(run.id);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED', attempts: 1 });

    expect(await h.store.deadLetterExhausted(reporter().onError)).toEqual([]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'CANCELLING', deadLetter: false });

    expect(await h.store.finishCancelled(reporter().onError)).toEqual([run.id]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'CANCELLED', deadLetter: false });
    expect(typesOf(h.store, run.id).filter((type) => type === 'context.contribution')).toHaveLength(1);
    expect(h.store.readRunEvents(run.id, 0, 1000).filter((event) => event.type === 'context.contribution').map((event) => (event.type === 'context.contribution' ? event.items : []))).toEqual([contributionOf('m1').items]);
  });
});
