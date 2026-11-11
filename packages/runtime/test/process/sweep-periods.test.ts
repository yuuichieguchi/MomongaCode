import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_PURGE_MS, JOB_END_PROBE_MS, JOB_IDEMPOTENCY_TTL_MS, RETENTION_SWEEPS_PER_LIFETIME, SESSION_TMP_SWEEP_MS, TOOL_MARKER_SWEEP_MS } from '../../src/process/constants.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the periods of the runtime sweeps follow their written rules (constants/runtime-store.md)', () => {
  it('the idempotency purge and the session scratch sweep run 168 times in the 7 days a record or a scratch area lives, which is once an hour', () => {
    expect(JOB_IDEMPOTENCY_TTL_MS).toBe(7 * DAY_MS);
    expect(RETENTION_SWEEPS_PER_LIFETIME).toBe(168);
    expect(IDEMPOTENCY_PURGE_MS).toBe(JOB_IDEMPOTENCY_TTL_MS / RETENTION_SWEEPS_PER_LIFETIME);
    expect(SESSION_TMP_SWEEP_MS).toBe(JOB_IDEMPOTENCY_TTL_MS / RETENTION_SWEEPS_PER_LIFETIME);
    expect(IDEMPOTENCY_PURGE_MS).toBe(3_600_000);
  });

  it('the tool marker sweep period and the bound of the check at a job end are the decided values (D17, D18)', () => {
    expect(TOOL_MARKER_SWEEP_MS).toBe(30_000);
    expect(JOB_END_PROBE_MS).toBe(120_000);
  });
});
