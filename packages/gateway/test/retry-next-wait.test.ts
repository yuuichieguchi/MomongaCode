import { describe, expect, it } from 'vitest';
import { nextWait } from '../src/core/retry.ts';
import { GATEWAY_CONFIG_DEFAULTS } from '../src/defaults.ts';

const lowest = { ...GATEWAY_CONFIG_DEFAULTS.retry, random: () => 0 };
const highest = { ...GATEWAY_CONFIG_DEFAULTS.retry, random: () => 0.999999 };

describe.each([
  ['with an alternative to leave to', false],
  ['without an alternative', true],
] as const)('nextWait %s: the wait is max(equal-jitter backoff, retryAfterMs)', (_name, lastCandidate) => {
  it('waits 250 to 499 ms after the first attempt, 500 ms after the second at the floor, 4000 ms at the 8 s cap', () => {
    expect(nextWait({ attempt: 0, elapsedMs: 0, policy: lowest, lastCandidate })).toEqual({ kind: 'wait', ms: 250 });
    expect(nextWait({ attempt: 0, elapsedMs: 0, policy: highest, lastCandidate })).toEqual({ kind: 'wait', ms: 499 });
    expect(nextWait({ attempt: 1, elapsedMs: 0, policy: lowest, lastCandidate })).toEqual({ kind: 'wait', ms: 500 });
    expect(nextWait({ attempt: 10, elapsedMs: 0, policy: lowest, lastCandidate })).toEqual({ kind: 'wait', ms: 4000 });
  });

  it('waits max(backoff, retryAfterMs), up to retry.maxMs', () => {
    expect(nextWait({ attempt: 0, retryAfterMs: 5000, elapsedMs: 0, policy: lowest, lastCandidate })).toEqual({ kind: 'wait', ms: 5000 });
    expect(nextWait({ attempt: 0, retryAfterMs: 100, elapsedMs: 0, policy: lowest, lastCandidate })).toEqual({ kind: 'wait', ms: 250 });
    expect(nextWait({ attempt: 0, retryAfterMs: 8000, elapsedMs: 0, policy: lowest, lastCandidate })).toEqual({ kind: 'wait', ms: 8000 });
  });

  it('leaves when elapsedMs + wait exceeds retry.totalWaitMs (84 s), and waits when it equals it', () => {
    expect(nextWait({ attempt: 0, elapsedMs: 83_750, policy: lowest, lastCandidate })).toEqual({ kind: 'wait', ms: 250 });
    expect(nextWait({ attempt: 0, elapsedMs: 83_751, policy: lowest, lastCandidate })).toEqual({ kind: 'leave' });
  });
});

describe('nextWait: a wait longer than retry.maxMs', () => {
  it('leaves when the caller has an alternative', () => {
    expect(nextWait({ attempt: 0, retryAfterMs: 8001, elapsedMs: 0, policy: lowest, lastCandidate: false })).toEqual({ kind: 'leave' });
  });

  it('is waited when the caller has none, within retry.totalWaitMs', () => {
    expect(nextWait({ attempt: 0, retryAfterMs: 8001, elapsedMs: 0, policy: lowest, lastCandidate: true })).toEqual({ kind: 'wait', ms: 8001 });
    expect(nextWait({ attempt: 0, retryAfterMs: 30_000, elapsedMs: 54_000, policy: lowest, lastCandidate: true })).toEqual({ kind: 'wait', ms: 30_000 });
    expect(nextWait({ attempt: 0, retryAfterMs: 30_000, elapsedMs: 54_001, policy: lowest, lastCandidate: true })).toEqual({ kind: 'leave' });
  });
});
