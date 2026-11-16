import { describe, expect, it } from 'vitest';
import type { LeasedElsewhere } from '@momonga/store';
import { makeEnv } from './harness.ts';
import type { ClaimHeldElsewhere } from '../../src/worker/types.ts';

describe('a worker that finds no run to claim', () => {
  it('reports once each run another live worker holds, naming itself, the run, the owner and the lease, and reports nothing when none is held', async () => {
    const env = await makeEnv();
    const held: LeasedElsewhere[] = [];
    const reported: ClaimHeldElsewhere[] = [];
    const store = { ...env.store, claim: () => null, leasedElsewhere: () => held };
    const worker = env.worker('worker-2', { store, onClaimHeldElsewhere: (fact) => reported.push(fact) });

    expect(await env.runOnce(worker)).toBe('idle');
    expect(reported).toEqual([]);

    held.push({ runId: 'run-1', owner: 'worker-1', leaseToken: 3 });
    expect(await env.runOnce(worker)).toBe('idle');
    expect(await env.runOnce(worker)).toBe('idle');
    expect(reported).toEqual([{ workerId: 'worker-2', runId: 'run-1', owner: 'worker-1', leaseToken: 3 }]);

    held.splice(0, 1, { runId: 'run-1', owner: 'worker-1', leaseToken: 4 });
    expect(await env.runOnce(worker)).toBe('idle');
    expect(reported).toHaveLength(2);
  });
});
