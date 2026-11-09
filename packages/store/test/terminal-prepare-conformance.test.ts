import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { EXPIRES_MS, awaitingApproval, awaitingInput } from './approval-fixture.ts';
import { LEASE_MS, cancel, enqueue, harness as plainHarness, mustClaim, mustRun, newSession } from './helpers.ts';
import { fakePreparer } from './preparer-fixture.ts';
import type { FakePreparer, Reply } from './preparer-fixture.ts';

const harness = (replies: Reply[] = []) => {
  const fake: FakePreparer = fakePreparer(replies);
  const h = plainHarness({ preparer: fake.preparer });
  fake.bind(h.store);
  return { ...h, fake };
};

const typesOf = (store: RuntimeStore, runId: string): string[] =>
  store
    .readRunEvents(runId, 0, 1000)
    .map((event) => (event.type === 'run.status' ? `run.status:${event.to}` : event.type));

const contributionsOf = (store: RuntimeStore, runId: string): number => typesOf(store, runId).filter((type) => type === 'context.contribution').length;

describe('facts that specs/tla/TerminalPrepare.tla relies on', () => {
  it('CommitFresh: fences a commit by the lease token alone: a holder whose lease expired and who nobody reclaimed still commits, with its contribution', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS + 1);

    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:COMPLETED']);
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('CommitLost, FencedCommit: refuses the commit of a superseded holder before anything is written, so its prepared result cannot reach the journal', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const stale = mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS + 1);
    const fresh = mustClaim(h.store, 'w2');
    const before = typesOf(h.store, run.id);

    expect(await h.store.transition(stale, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });

    expect(typesOf(h.store, run.id)).toEqual(before);
    expect(contributionsOf(h.store, run.id)).toBe(0);
    expect((await h.store.transition(fresh, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('Stop, AtMostOneContribution: leaves a finished run with one contribution whatever finisher comes next: a holder, a service cancel and a second transition all find it terminal', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const settled = mustRun(h.store, run.id).lastSeq;

    expect(await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });
    expect(await h.store.requestCancel(run.id)).toMatchObject({ kind: 'ok', changed: false });

    expect(mustRun(h.store, run.id).lastSeq).toBe(settled);
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('Cancel: lets a service cancel append to the journal of a running run without the lease, which moves lastSeq under a holder that is finishing', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const seen = mustRun(h.store, run.id).lastSeq;

    expect((await cancel(h.store, run.id)).status).toBe('CANCELLING');

    expect(mustRun(h.store, run.id).lastSeq).toBeGreaterThan(seen);
    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('conflict');
    expect((await h.store.transition(claim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');
    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:CANCELLED']);
    expect(contributionsOf(h.store, run.id)).toBe(1);
  });

  it('CommitRefuseStale: a preparation of an older lastSeq refuses the commit, which writes nothing; the operation prepares again and commits once', async () => {
    const h = harness([{ kind: 'stale', id: 'old' }, { kind: 'fresh', id: 'new' }]);
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const before = typesOf(h.store, run.id);
    const journalAtSecondRead: string[][] = [];
    h.fake.during((_request, call) => {
      if (call === 2) journalAtSecondRead.push(typesOf(h.store, run.id));
    });

    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(h.fake.requests).toHaveLength(2);
    expect(journalAtSecondRead).toEqual([before]);
    expect(contributionsOf(h.store, run.id)).toBe(1);
    expect(typesOf(h.store, run.id).slice(-2)).toEqual(['context.contribution', 'run.status:COMPLETED']);
  });

  it('ApprovalRowsMatchJournal: the commit ends exactly the waits of prepared.leading when a request for input falls due after the preparation', async () => {
    const h = harness();
    const later = EXPIRES_MS + 60_000;
    const { runId, approvals } = await awaitingInput(h.store, [{ callId: 'call_1' }, { callId: 'call_2', expiresAt: later }], 'waiting');
    const [first, second] = approvals;
    if (first === undefined || second === undefined) throw new Error('expected two requests for input');
    h.fake.during(() => {
      h.clock.advance(later + 1 - h.clock.now());
    });

    expect(await h.store.expireApprovals(EXPIRES_MS, (error: unknown) => { throw error; })).toEqual([runId]);

    expect(h.fake.requests).toHaveLength(1);
    const leadingCancels = (h.fake.requests[0]?.leading ?? []).flatMap((event) => (event.type === 'tool.elicitation.cancelled' ? [{ inputId: event.inputId, reason: event.reason }] : []));
    expect(leadingCancels).toEqual([{ inputId: first.id, reason: 'expired' }]);
    expect((await h.store.elicitationView(first.id))?.status).toBe('expired');
    expect((await h.store.elicitationView(second.id))?.status).toBe('withdrawn');
    const journalCancels = h.store
      .readRunEvents(runId, 0, 1000)
      .flatMap((event) => (event.type === 'tool.elicitation.cancelled' ? [{ inputId: event.inputId, reason: event.reason }] : []));
    expect(journalCancels).toEqual([
      { inputId: first.id, reason: 'expired' },
      { inputId: second.id, reason: 'withdrawn' },
    ]);
    expect(mustRun(h.store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
  });

  it('Keepalive is absent: a heartbeat appends no event, which RePrepareBounded and Terminates need', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const before = mustRun(h.store, run.id).lastSeq;
    const typesBefore = typesOf(h.store, run.id);

    for (let beat = 0; beat < 5; beat += 1) {
      h.clock.advance(LEASE_MS / 4);
      expect(h.store.heartbeat(claim).kind).toBe('ok');
    }

    expect(mustRun(h.store, run.id).lastSeq).toBe(before);
    expect(typesOf(h.store, run.id)).toEqual(typesBefore);
  });
});
