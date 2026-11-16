import { describe, expect, it } from 'vitest';
import { LEASE_MS, enqueue, harness, mustClaim, newSession } from './helpers.ts';

describe('the runs held by another live worker', () => {
  it('names the run, its owner and its lease while the lease lives, never the asker, and nothing once the lease expired', async () => {
    const h = harness();
    const session = newSession(h.store);
    const run = await enqueue(h.store, session.id);
    const claim = mustClaim(h.store, 'worker-a');

    expect(h.store.claim('worker-b')).toBeNull();
    expect(h.store.leasedElsewhere('worker-b')).toEqual([{ runId: run.id, owner: 'worker-a', leaseToken: claim.leaseToken }]);
    expect(h.store.leasedElsewhere('worker-a')).toEqual([]);

    h.clock.advance(LEASE_MS);
    expect(h.store.leasedElsewhere('worker-b')).toEqual([]);
  });
});
