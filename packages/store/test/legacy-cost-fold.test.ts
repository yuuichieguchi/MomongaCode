import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const started = { type: 'run.started', pins: {} } as unknown as RunEventPayload;

describe('the spend of a run that holds a cost record written before exact units', () => {
  it('counts the record apart beside its approximate money, and reads the journal event back with units null', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    store.append(claim, [
      started,
      { type: 'usage.charged', purpose: 'compaction', inputTokens: 5, outputTokens: 1, totalTokens: 6, cost: { amount: 0.0000015004, currency: 'USD', priceVersion: '2026-01-01' } } as unknown as RunEventPayload,
      { type: 'usage.charged', purpose: 'compaction', inputTokens: 5, outputTokens: 1, totalTokens: 6, cost: { amount: 0.000001, units: '1000000000', currency: 'USD', priceVersion: '2026-01-01' } },
    ]);

    expect(mustRun(store, run.id).usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12, costNano: 2501, legacyPrecisionCalls: 1 });
    const [legacy] = store.readRunEventsOfTypes(run.id, ['usage.charged']);
    expect(legacy).toMatchObject({ cost: { amount: 0.0000015004, units: null } });
  });
});
