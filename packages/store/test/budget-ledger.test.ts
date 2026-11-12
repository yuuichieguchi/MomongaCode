import { describe, expect, it } from 'vitest';
import type { AdmissionAsk, RunEventPayload } from '@momonga/protocol';
import type { Run, RuntimeStore } from '@momonga/store';
import { MIGRATIONS } from '../src/schema.ts';
import { LEASE_MS, TIMEOUT_MS, deadLetterAll, enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';

const responded = (step: number, total: number, momonga?: Record<string, unknown>): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { input: 'x' } },
  {
    type: 'model.responded',
    step,
    attempt: 1,
    response: { status: 'completed', output: [], usage: { input_tokens: total - 1, output_tokens: 1, total_tokens: total }, ...(momonga === undefined ? {} : { momonga }) },
  } as RunEventPayload,
];

const started: RunEventPayload = { type: 'run.started', pins: {} } as unknown as RunEventPayload;

const PRICE = { inUnits: 3_000_000n, outUnits: 15_000_000n };

const ask = (over: Partial<AdmissionAsk> = {}): AdmissionAsk => ({ inputUpper: 1000, outputWanted: 4000, outputFloor: 256, price: PRICE, limits: { tokens: 100_000, costNano: 100_000 }, ...over });

const spawn = async (store: RuntimeStore, parent: Run, callId: string) => {
  const result = await store.createChildRun({ parentRunId: parent.id, parentCallId: callId, input: 'child task', pins: { agent: { name: 'helper' } }, model: 'fm' });
  if (result.kind !== 'created') throw new Error(`expected a child run, got ${result.kind}`);
  return result.run;
};

describe('migration 37 holds the reservation of a run', () => {
  it('adds reserved_tokens and reserved_nano to runs, zero by default', () => {
    expect(MIGRATIONS.find((entry) => entry.version === 37)?.sql).toMatch(/reserved_nano/);
    const { dbPath } = harness();
    const columns = rawDb(dbPath).prepare("SELECT name, dflt_value AS preset FROM pragma_table_info('runs') WHERE name LIKE 'reserved_%' ORDER BY name").all();
    expect(columns).toEqual([
      { name: 'reserved_nano', preset: '0' },
      { name: 'reserved_tokens', preset: '0' },
    ]);
  });
});

describe('the spend of a run folds money beside tokens', () => {
  it('adds the cost of a priced response in nano-USD rounded up, and counts an unpriced one', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    store.append(claim, [started, ...responded(1, 10, { cost: { amount: 0.0000015004, units: '1500400000', currency: 'USD', priceVersion: '2026-01-01' } })]);
    expect(mustRun(store, run.id).usage).toEqual({ inputTokens: 9, outputTokens: 1, totalTokens: 10, costNano: 1501 });
    store.append(claim, responded(2, 4, { unpriced: { code: 'no_price_entry', reason: 'no price entry' } }));
    store.append(claim, [{ type: 'usage.charged', purpose: 'compaction', inputTokens: 5, outputTokens: 1, totalTokens: 6, cost: { amount: 0.000001, units: '1000000000', currency: 'USD', priceVersion: '2026-01-01' } }]);
    expect(mustRun(store, run.id).usage).toEqual({ inputTokens: 17, outputTokens: 3, totalTokens: 20, costNano: 2501, unpricedCalls: 1 });
  });

  it('keeps the usage of a run with no priced call as it was before, with no money fields', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    store.append(claim, [started, ...responded(1, 10)]);
    expect(mustRun(store, run.id).usage).toEqual({ inputTokens: 9, outputTokens: 1, totalTokens: 10 });
    expect(store.treeSpend(run.id)).toMatchObject({ totalTokens: 10, costNano: 0, unpricedCalls: 0, reservedTokens: 0, reservedNano: 0 });
  });
});

describe('admission of a model request is one transaction over the run tree', () => {
  it('reserves the worst case of the admitted request on the run, and shows it to the rest of the tree', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    expect(store.admitModelRequest(claim, ask())).toEqual({ kind: 'admitted', maxOutputTokens: 4000, reservedTokens: 5000, reservedNano: 63_000 });
    expect(store.treeSpend(run.id)).toMatchObject({ reservedTokens: 5000, reservedNano: 63_000 });
  });

  it('replaces the reservation of the same run instead of adding to it, so a request admitted again after a crash is counted once', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    store.admitModelRequest(claim, ask());
    expect(store.admitModelRequest(claim, ask())).toMatchObject({ kind: 'admitted', maxOutputTokens: 4000 });
    expect(store.treeSpend(run.id)).toMatchObject({ reservedTokens: 5000, reservedNano: 63_000 });
  });

  it('lets two runs of one tree together reserve no more than the limit', async () => {
    const h = harness();
    const parent = await enqueue(h.store, newSession(h.store).id);
    const parentClaim = mustClaim(h.store, 'w-parent');
    const child = await spawn(h.store, mustRun(h.store, parent.id), 'call-1');
    const childClaim = mustClaim(h.store, 'w-child');
    expect(childClaim.runId).toBe(child.id);
    const limits = { costNano: 100_000 };
    expect(h.store.admitModelRequest(parentClaim, ask({ limits }))).toMatchObject({ kind: 'admitted', reservedNano: 63_000 });
    const second = h.store.admitModelRequest(childClaim, ask({ limits }));
    expect(second).toMatchObject({ kind: 'admitted', maxOutputTokens: 2266, reservedNano: 36_990 });
    expect(h.store.admitModelRequest(childClaim, ask({ limits: { costNano: 66_000 } }))).toEqual({ kind: 'refused', dimension: 'cost', cause: 'cap_too_small', spent: 63_000, limit: 66_000 });
    const spend = h.store.treeSpend(parent.id);
    expect(spend.costNano + spend.reservedNano).toBeLessThanOrEqual(100_000);
    expect(spend.runsRead).toBe(2);
  });

  it('clears the reservation in the one transaction that records the spend of the request, and no longer counts the reservation of a run that ended', async () => {
    const h = harness();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.store.admitModelRequest(claim, ask());
    h.store.append(claim, [started, ...responded(1, 10).slice(0, 1)]);
    expect(h.store.treeSpend(run.id)).toMatchObject({ reservedTokens: 5000, reservedNano: 63_000 });
    h.store.append(claim, responded(1, 10).slice(1));
    expect(h.store.treeSpend(run.id)).toMatchObject({ totalTokens: 10, reservedTokens: 0, reservedNano: 0 });
    h.store.admitModelRequest(claim, ask());
    h.store.append(claim, [{ type: 'usage.charged', purpose: 'rejected_answer', inputTokens: 5, outputTokens: 1, totalTokens: 6 }]);
    expect(h.store.treeSpend(run.id)).toMatchObject({ totalTokens: 16, reservedTokens: 0, reservedNano: 0 });
    h.store.admitModelRequest(claim, ask());
    await h.store.transition(claim, ['RUNNING'], 'STOPPED', { stopReason: 'budget' });
    expect(mustRun(h.store, run.id).status).toBe('STOPPED');
    expect(h.store.treeSpend(run.id)).toMatchObject({ reservedTokens: 0, reservedNano: 0 });
  });

  it('keeps the reservation of a request whose run is requeued before its spend is recorded', async () => {
    const h = harness();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.store.admitModelRequest(claim, ask());
    h.store.append(claim, [started]);
    expect((await h.store.release(claim, 'QUEUED')).kind).toBe('ok');
    expect(h.store.treeSpend(run.id)).toMatchObject({ reservedTokens: 5000, reservedNano: 63_000 });
  });

  it('re-takes the reservation recorded with a request that is sent again, under the lease of the claim', async () => {
    const h = harness();
    const run = await enqueue(h.store, newSession(h.store).id);
    const stale = mustClaim(h.store, 'w1');
    expect(h.store.reserveRecorded(stale, { reservedTokens: 700, reservedNano: 900 })).toEqual({ kind: 'ok' });
    expect(h.store.treeSpend(run.id)).toMatchObject({ reservedTokens: 700, reservedNano: 900 });
    h.clock.advance(LEASE_MS);
    const current = mustClaim(h.store, 'w2');
    expect(h.store.reserveRecorded(stale, { reservedTokens: 1, reservedNano: 1 })).toEqual({ kind: 'lease_lost' });
    expect(h.store.reserveRecorded(current, { reservedTokens: 800 })).toEqual({ kind: 'ok' });
    expect(h.store.treeSpend(run.id)).toMatchObject({ reservedTokens: 800, reservedNano: 0 });
  });

  it('answers lease_lost to a worker that no longer holds the run, and reserves nothing', async () => {
    const h = harness();
    const run = await enqueue(h.store, newSession(h.store).id);
    const stale = mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS);
    mustClaim(h.store, 'w2');
    expect(h.store.admitModelRequest(stale, ask())).toEqual({ kind: 'lease_lost' });
    expect(h.store.treeSpend(run.id)).toMatchObject({ reservedTokens: 0 });
  });
});

describe('the retries of a run are bounded by its own limit under the store maximum', () => {
  const enqueueWith = async (store: RuntimeStore, limits: Record<string, unknown>): Promise<Run> => {
    const result = await store.createRunAndEnqueue(newSession(store).id, { input: 'hello', timeoutMs: TIMEOUT_MS, limits, pins: { model: 'fm' } });
    if (result.kind !== 'created') throw new Error(`expected a run, got ${result.kind}`);
    return result.run;
  };

  it('dead-letters a run after its own number of consecutive failed attempts, naming that number', async () => {
    const h = harness({ maxAttempts: 5 });
    const run = await enqueueWith(h.store, { maxFailedAttempts: 2 });
    mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS);
    mustClaim(h.store, 'w2');
    h.clock.advance(LEASE_MS);
    expect(h.store.claim('w3')).toBeNull();
    expect(await deadLetterAll(h.store)).toEqual([run.id]);
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'FAILED', error: { code: 'max_attempts', message: `run ${run.id} exceeded 2 consecutive failed attempts` } });
  });

  it('never lets the limit of a run raise the store maximum', async () => {
    const h = harness({ maxAttempts: 2 });
    const run = await enqueueWith(h.store, { maxFailedAttempts: 9 });
    mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS);
    mustClaim(h.store, 'w2');
    h.clock.advance(LEASE_MS);
    expect(h.store.claim('w3')).toBeNull();
    expect(await deadLetterAll(h.store)).toEqual([run.id]);
  });
});
