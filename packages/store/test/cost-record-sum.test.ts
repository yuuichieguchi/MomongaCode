import { describe, expect, it } from 'vitest';
import type { ModelCost, RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const cost = (units: string, amount: number, priceVersion: string): ModelCost => ({ amount, units, currency: 'USD', priceVersion });

const started = { type: 'run.started', pins: {} } as unknown as RunEventPayload;

const responded = (step: number, recorded: ModelCost): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { input: 'x' } } as unknown as RunEventPayload,
  { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 }, momonga: { cost: recorded } } } as RunEventPayload,
];

describe('the spend of a run tree is the sum of the recorded costs of its model calls', () => {
  it('sums the costs the journal recorded for the main and the side calls of the root and of its child, each at the price version it was recorded with', async () => {
    const { store } = harness();
    const root = await enqueue(store, newSession(store).id);
    const rootClaim = mustClaim(store, 'w-root');
    store.append(rootClaim, [
      started,
      ...responded(1, cost('2000000000000000', 2, '2026-01-01')),
      { type: 'usage.charged', purpose: 'compaction', inputTokens: 5, outputTokens: 1, totalTokens: 6, cost: cost('500000000000000', 0.5, '2026-06-01') },
    ]);
    const spawned = await store.createChildRun({ parentRunId: root.id, parentCallId: 'call-1', input: 'child task', pins: { agent: { name: 'helper' } }, model: 'fm' });
    if (spawned.kind !== 'created') throw new Error(`expected a child run, got ${spawned.kind}`);
    const childClaim = mustClaim(store, 'w-child');
    store.append(childClaim, [started, ...responded(1, cost('250000000000000', 0.25, '2026-06-01'))]);

    expect(mustRun(store, root.id).usage.costNano).toBe(2_500_000_000);
    expect(mustRun(store, spawned.run.id).usage.costNano).toBe(250_000_000);
    expect(store.treeSpend(root.id)).toMatchObject({ costNano: 2_750_000_000, unpricedCalls: 0 });
  });
});
