import { describe, expect, it } from 'vitest';
import { globBudgetMs } from '@momonga/policy';
import { heartbeatMsFor } from '../../src/worker/heartbeat.ts';

describe('heartbeatMsFor, the one derivation of the heartbeat period', () => {
  it('is a third of the lease', () => {
    expect(heartbeatMsFor(30_000)).toBe(10_000);
    expect(heartbeatMsFor(120_000)).toBe(40_000);
  });

  it('leaves the glob budget of the default lease at 20 s, and follows --lease-ms', () => {
    expect(globBudgetMs({ leaseMs: 30_000, heartbeatMs: heartbeatMsFor(30_000) })).toBe(20_000);
    expect(globBudgetMs({ leaseMs: 120_000, heartbeatMs: heartbeatMsFor(120_000) })).toBe(80_000);
  });
});
