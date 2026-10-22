import { describe, expect, it } from 'vitest';
import { initialRunState } from '@momonga/store';
import type { Claim, RuntimeStore } from '@momonga/store';
import { LEASE_MS, START_MS, enqueue, harness, mustClaim, mustRun, newSession, openStoreAt, rawDb } from './helpers.ts';

describe('claim', () => {
  it('returns null when nothing is queued', () => {
    const { store } = harness();
    expect(store.claim('w1')).toBeNull();
  });

  it('claims a queued run, making it RUNNING with a fresh lease', () => {
    const { clock, store } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id);
    clock.advance(5);
    const claim = mustClaim(store, 'w1');
    expect(claim).toEqual({ runId: run.id, sessionId: session.id, workerId: 'w1', leaseToken: 1, attempt: 1, status: 'RUNNING' });
    expect(mustRun(store, run.id)).toMatchObject({
      status: 'RUNNING',
      leaseOwner: 'w1',
      leaseToken: 1,
      leaseExpiresAt: START_MS + 5 + LEASE_MS,
      attempts: 1,
    });
    expect(store.claim('w2')).toBeNull();
  });

  it('claims oldest available first across sessions', () => {
    const { clock, store } = harness();
    const late = enqueue(store, newSession(store, '/a').id);
    clock.advance(1);
    const early = enqueue(store, newSession(store, '/b').id);
    clock.advance(1);
    store.release(mustClaim(store, 'w0'), 'QUEUED', START_MS + 100);
    expect(mustClaim(store, 'w1').runId).toBe(early.id);
    clock.set(START_MS + 100);
    expect(mustClaim(store, 'w2').runId).toBe(late.id);
  });

  it('breaks available_at ties by creation time', () => {
    const { clock, store } = harness();
    const first = enqueue(store, newSession(store, '/a').id);
    clock.advance(1);
    const second = enqueue(store, newSession(store, '/b').id);
    const firstClaim = mustClaim(store, 'w1');
    store.release(firstClaim, 'QUEUED', START_MS + 50);
    const secondClaim = mustClaim(store, 'w1');
    store.release(secondClaim, 'QUEUED', START_MS + 50);
    clock.set(START_MS + 50);
    expect(mustClaim(store, 'w2').runId).toBe(first.id);
    expect(mustClaim(store, 'w3').runId).toBe(second.id);
  });

  it('does not claim a run before its available_at', () => {
    const { clock, store } = harness();
    enqueue(store, newSession(store).id);
    store.release(mustClaim(store, 'w1'), 'QUEUED', START_MS + 500);
    clock.set(START_MS + 499);
    expect(store.claim('w2')).toBeNull();
    clock.set(START_MS + 500);
    expect(store.claim('w2')).not.toBeNull();
  });

  it('serializes runs within a session until the earlier one is terminal', () => {
    const { clock, store } = harness();
    const session = newSession(store);
    const r1 = enqueue(store, session.id, 'one');
    clock.advance(1);
    const r2 = enqueue(store, session.id, 'two');
    const c1 = mustClaim(store, 'w1');
    expect(c1.runId).toBe(r1.id);
    expect(store.claim('w2')).toBeNull();
    expect(store.release(c1, 'WAITING_HUMAN').kind).toBe('ok');
    expect(store.claim('w2')).toBeNull();
    const queued = mustRun(store, r1.id);
    expect(store.appendAsService(r1.id, queued.version, 'QUEUED', []).kind).toBe('ok');
    const again = mustClaim(store, 'w2');
    expect(again.runId).toBe(r1.id);
    expect(store.release(again, 'COMPLETED').kind).toBe('ok');
    expect(mustClaim(store, 'w3').runId).toBe(r2.id);
  });

  it('reclaims a RUNNING run only after its lease expired, keeping RUNNING and bumping token and attempt', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS - 1);
    expect(store.claim('w2')).toBeNull();
    clock.advance(1);
    const claim = mustClaim(store, 'w2');
    expect(claim).toMatchObject({ runId: run.id, workerId: 'w2', leaseToken: 2, attempt: 2, status: 'RUNNING' });
    expect(mustRun(store, run.id).leaseOwner).toBe('w2');
  });

  it('reclaims an expired CANCELLING run as CANCELLING', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    expect(store.requestCancel(run.id).status).toBe('CANCELLING');
    clock.advance(LEASE_MS);
    const claim = mustClaim(store, 'w2');
    expect(claim.status).toBe('CANCELLING');
    expect(mustRun(store, run.id).status).toBe('CANCELLING');
  });

  it('dead-letters a run whose attempts would exceed maxAttempts and moves on to the next candidate', () => {
    const { clock, store } = harness({ maxAttempts: 2 });
    const doomed = enqueue(store, newSession(store, '/a').id);
    clock.advance(1);
    const healthy = enqueue(store, newSession(store, '/b').id);
    expect(mustClaim(store, 'w1').runId).toBe(doomed.id);
    expect(mustClaim(store, 'w1').runId).toBe(healthy.id);
    clock.advance(LEASE_MS);
    expect(mustClaim(store, 'w2')).toMatchObject({ runId: doomed.id, attempt: 2 });
    clock.advance(LEASE_MS);
    const next = mustClaim(store, 'w3');
    expect(next.runId).toBe(healthy.id);
    expect(mustRun(store, doomed.id)).toMatchObject({ status: 'FAILED', deadLetter: true, attempts: 2, leaseOwner: null });
    const last = store.readRunEvents(doomed.id, 0, 100).at(-1);
    expect(last).toMatchObject({ type: 'run.status', from: 'RUNNING', to: 'FAILED', reason: 'max_attempts' });
  });

  it('returns null after dead-lettering when there is no other candidate', () => {
    const { clock, store } = harness({ maxAttempts: 1 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS);
    expect(store.claim('w2')).toBeNull();
    expect(mustRun(store, run.id).status).toBe('FAILED');
  });

  it('never hands the same run to two connections', () => {
    const { dbPath, clock, store } = harness();
    const other = openStoreAt(dbPath, clock);
    enqueue(store, newSession(store).id);
    const results = [store.claim('a'), other.claim('b'), store.claim('c'), other.claim('d')];
    expect(results.filter((claim) => claim !== null)).toHaveLength(1);
  });
});

describe('attempt accounting', () => {
  const resume = (store: RuntimeStore, runId: string, claim: Claim, via: 'WAITING_HUMAN' | 'WAITING_TOOL' | 'RUNNING') => {
    if (via === 'RUNNING') {
      expect(store.release(claim, 'QUEUED').kind).toBe('ok');
      return;
    }
    expect(store.release(claim, via).kind).toBe('ok');
    const parked = mustRun(store, runId);
    expect(store.appendAsService(runId, parked.version, 'QUEUED', []).kind).toBe('ok');
  };

  it.each(['WAITING_HUMAN', 'WAITING_TOOL', 'RUNNING'] as const)(
    'never dead-letters a run that voluntarily gives up its lease more often than maxAttempts (%s)',
    (via) => {
      const { store } = harness({ maxAttempts: 2 });
      const run = enqueue(store, newSession(store).id);
      for (let round = 1; round <= 7; round += 1) {
        const claim = mustClaim(store, 'w1');
        expect(claim.attempt).toBe(round);
        resume(store, run.id, claim, via);
        expect(mustRun(store, run.id)).toMatchObject({ status: 'QUEUED', deadLetter: false, attempts: round, failedAttempts: 0 });
      }
    },
  );

  it('dead-letters after maxAttempts crashed holders', () => {
    const { clock, store } = harness({ maxAttempts: 3 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS);
    expect(mustClaim(store, 'w2')).toMatchObject({ attempt: 2 });
    expect(mustRun(store, run.id).failedAttempts).toBe(1);
    clock.advance(LEASE_MS);
    expect(mustClaim(store, 'w3')).toMatchObject({ attempt: 3 });
    expect(mustRun(store, run.id).failedAttempts).toBe(2);
    clock.advance(LEASE_MS);
    expect(store.claim('w4')).toBeNull();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true, attempts: 3, failedAttempts: 2 });
  });

  it('forgives earlier crashes once the holder releases voluntarily', () => {
    const { clock, store } = harness({ maxAttempts: 2 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS);
    const takeover = mustClaim(store, 'w2');
    expect(mustRun(store, run.id).failedAttempts).toBe(1);
    expect(store.release(takeover, 'QUEUED').kind).toBe('ok');
    expect(mustRun(store, run.id).failedAttempts).toBe(0);
    const again = mustClaim(store, 'w3');
    clock.advance(LEASE_MS);
    expect(mustClaim(store, 'w4').runId).toBe(run.id);
    expect(mustRun(store, run.id)).toMatchObject({ deadLetter: false, failedAttempts: 1 });
    expect(again.attempt).toBe(3);
  });

  it('ends an exhausted CANCELLING run as CANCELLED, keeping the cancel intent', () => {
    const { clock, store } = harness({ maxAttempts: 1 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    store.requestCancel(run.id);
    clock.advance(LEASE_MS);
    expect(store.claim('w2')).toBeNull();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'CANCELLED', deadLetter: true, cancelRequested: true, leaseOwner: null });
    expect(store.readRunEvents(run.id, 0, 100).at(-1)).toMatchObject({
      type: 'run.status',
      from: 'CANCELLING',
      to: 'CANCELLED',
      reason: 'max_attempts',
    });
  });

  it('ends an exhausted RUNNING run as FAILED', () => {
    const { clock, store } = harness({ maxAttempts: 1 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS);
    expect(store.claim('w2')).toBeNull();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    expect(mustRun(store, run.id).error).toMatchObject({ code: 'max_attempts' });
  });
});

describe('total attempt cap', () => {
  it('dead-letters a run that keeps cycling through crash, takeover and voluntary release', () => {
    const { clock, store } = harness({ maxAttempts: 2, maxTotalAttempts: 6 });
    const run = enqueue(store, newSession(store).id);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      mustClaim(store, 'crasher');
      clock.advance(LEASE_MS);
      const takeover = mustClaim(store, 'healer');
      expect(store.release(takeover, 'QUEUED').kind).toBe('ok');
      expect(mustRun(store, run.id)).toMatchObject({ deadLetter: false, failedAttempts: 0, attempts: (cycle + 1) * 2 });
    }
    expect(store.claim('w')).toBeNull();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true, attempts: 6 });
    expect(store.readRunEvents(run.id, 0, 100).at(-1)).toMatchObject({
      type: 'run.status',
      from: 'QUEUED',
      to: 'FAILED',
      reason: 'max_total_attempts',
    });
    expect(mustRun(store, run.id).error).toMatchObject({ code: 'max_total_attempts' });
  });

  it('leaves normal resumes within the cap alone', () => {
    const { store } = harness({ maxAttempts: 2, maxTotalAttempts: 8 });
    const run = enqueue(store, newSession(store).id);
    for (let round = 1; round <= 8; round += 1) {
      const claim = mustClaim(store, 'w1');
      expect(claim.attempt).toBe(round);
      expect(store.release(claim, 'QUEUED').kind).toBe('ok');
    }
    expect(mustRun(store, run.id)).toMatchObject({ status: 'QUEUED', deadLetter: false });
    expect(store.claim('w1')).toBeNull();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
  });

  it('ends a run over the cap as CANCELLED when cancel was requested', () => {
    const { clock, store } = harness({ maxAttempts: 1, maxTotalAttempts: 1 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    store.requestCancel(run.id);
    clock.advance(LEASE_MS);
    expect(store.claim('w2')).toBeNull();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'CANCELLED', deadLetter: true, cancelRequested: true });
    expect(store.readRunEvents(run.id, 0, 100).at(-1)).toMatchObject({ from: 'CANCELLING', to: 'CANCELLED', reason: 'max_total_attempts' });
  });
});

describe('heartbeat lease renewal', () => {
  it('renews an expired lease that nobody reclaimed', () => {
    const { clock, store } = harness();
    enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    clock.advance(LEASE_MS * 10);
    expect(store.heartbeat(claim).kind).toBe('ok');
    expect(store.claim('w2')).toBeNull();
  });

  it('refuses to renew once another worker reclaimed the run', () => {
    const { clock, store } = harness();
    enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    clock.advance(LEASE_MS);
    mustClaim(store, 'w2');
    expect(store.heartbeat(claim)).toEqual({ kind: 'lease_lost' });
  });
});

describe('heartbeat', () => {
  it('extends the lease so another worker cannot claim', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    clock.advance(800);
    expect(store.heartbeat(claim)).toEqual({ kind: 'ok', cancelRequested: false, status: 'RUNNING' });
    expect(mustRun(store, run.id).leaseExpiresAt).toBe(START_MS + 800 + LEASE_MS);
    clock.advance(700);
    expect(store.claim('w2')).toBeNull();
    clock.advance(300);
    expect(store.claim('w2')?.runId).toBe(run.id);
  });

  it('reports a pending cancel request', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    store.requestCancel(run.id);
    expect(store.heartbeat(claim)).toEqual({ kind: 'ok', cancelRequested: true, status: 'CANCELLING' });
  });

  it('renews an expired lease nobody else has taken', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    clock.advance(LEASE_MS + 10);
    expect(store.heartbeat(claim).kind).toBe('ok');
    expect(mustRun(store, run.id).leaseExpiresAt).toBe(START_MS + LEASE_MS + 10 + LEASE_MS);
  });

  it('returns lease_lost for a wrong owner or token', () => {
    const { store } = harness();
    enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    expect(store.heartbeat({ ...claim, workerId: 'intruder' })).toEqual({ kind: 'lease_lost' });
    expect(store.heartbeat({ ...claim, leaseToken: claim.leaseToken + 1 })).toEqual({ kind: 'lease_lost' });
  });
});

describe('release', () => {
  it('clears the lease and makes the run claimable again at availableAt', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const result = store.release(claim, 'QUEUED', START_MS + 200);
    expect(result.kind).toBe('ok');
    expect(mustRun(store, run.id)).toMatchObject({
      status: 'QUEUED',
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseToken: 1,
      availableAt: START_MS + 200,
    });
    expect(store.readRunEvents(run.id, 0, 100).at(-1)).toMatchObject({ type: 'run.status', from: 'RUNNING', to: 'QUEUED' });
    clock.set(START_MS + 200);
    expect(mustClaim(store, 'w2').leaseToken).toBe(2);
  });

  it('defaults availableAt to now', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    clock.advance(42);
    store.release(claim, 'QUEUED');
    expect(mustRun(store, run.id).availableAt).toBe(START_MS + 42);
  });

  it('is fenced', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    expect(store.release({ ...claim, leaseToken: 99 }, 'QUEUED')).toEqual({ kind: 'lease_lost' });
    expect(mustRun(store, run.id).status).toBe('RUNNING');
  });
});

describe('requestCancel', () => {
  it('cancels a QUEUED run directly', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const cancelled = store.requestCancel(run.id);
    expect(cancelled).toMatchObject({ id: run.id, status: 'CANCELLED' });
    expect(store.readRunEvents(run.id, 0, 10).at(-1)).toMatchObject({ type: 'run.status', from: 'QUEUED', to: 'CANCELLED' });
    expect(store.claim('w1')).toBeNull();
  });

  it('cancels a WAITING_HUMAN run directly', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    store.release(mustClaim(store, 'w1'), 'WAITING_HUMAN');
    expect(store.requestCancel(run.id).status).toBe('CANCELLED');
  });

  it('moves a RUNNING run to CANCELLING with cancel_requested', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    expect(store.requestCancel(run.id)).toMatchObject({ status: 'CANCELLING', cancelRequested: true, leaseOwner: 'w1' });
  });

  it('moves a WAITING_TOOL run to CANCELLING and makes it claimable now', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    store.release(mustClaim(store, 'w1'), 'WAITING_TOOL', START_MS + 1_000_000);
    clock.advance(7);
    expect(store.requestCancel(run.id)).toMatchObject({
      status: 'CANCELLING',
      cancelRequested: true,
      availableAt: START_MS + 7,
    });
    const claim = mustClaim(store, 'w2');
    expect(claim).toMatchObject({ runId: run.id, status: 'CANCELLING' });
  });

  it('leaves a terminal run unchanged', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    store.release(mustClaim(store, 'w1'), 'COMPLETED');
    const before = mustRun(store, run.id);
    const lastSeq = store.readRunEvents(run.id, 0, 100).length;
    expect(store.requestCancel(run.id)).toEqual(before);
    expect(store.readRunEvents(run.id, 0, 100)).toHaveLength(lastSeq);
  });

  it('throws for an unknown run', () => {
    const { store } = harness();
    expect(() => store.requestCancel('nope')).toThrow(/nope/);
  });
});

describe('fencing across connections', () => {
  it('rejects every write from the stale lease holder and writes nothing', () => {
    const { dbPath, clock, store: workerA } = harness();
    const workerB = openStoreAt(dbPath, clock);
    const run = enqueue(workerA, newSession(workerA).id);
    const claimA = mustClaim(workerA, 'A');
    expect(workerA.append(claimA, [{ type: 'notice', level: 'info', message: 'from A' }])).toEqual({ kind: 'ok', lastSeq: 2 });
    clock.advance(LEASE_MS + 1);
    const claimB = mustClaim(workerB, 'B');
    expect(claimB.leaseToken).toBe(claimA.leaseToken + 1);
    const before = mustRun(workerB, run.id);
    const eventsBefore = rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM events').get();

    expect(workerA.append(claimA, [{ type: 'notice', level: 'info', message: 'stale' }])).toEqual({ kind: 'lease_lost' });
    expect(workerA.heartbeat(claimA)).toEqual({ kind: 'lease_lost' });
    expect(workerA.transition(claimA, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });
    expect(workerA.writeSnapshot(claimA, 2, initialRunState({ runId: run.id, sessionId: run.sessionId }))).toEqual({ kind: 'lease_lost' });
    expect(workerA.release(claimA, 'QUEUED')).toEqual({ kind: 'lease_lost' });

    expect(mustRun(workerB, run.id)).toEqual(before);
    expect(rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(eventsBefore);
    expect(rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM snapshots').get()).toEqual({ n: 0 });
    expect(workerB.append(claimB, [{ type: 'notice', level: 'info', message: 'from B' }])).toEqual({ kind: 'ok', lastSeq: 3 });
  });
});
