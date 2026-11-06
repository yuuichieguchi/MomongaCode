import { describe, expect, it } from 'vitest';
import { nextWait } from '../src/core/retry.ts';
import { GATEWAY_CONFIG_DEFAULTS } from '../src/defaults.ts';

const lowest = { ...GATEWAY_CONFIG_DEFAULTS.retry, random: () => 0 };
const highest = { ...GATEWAY_CONFIG_DEFAULTS.retry, random: () => 0.999999 };

describe('nextWait: the one rule for the wait between attempts (design section 6)', () => {
  it('waits the equal-jitter backoff: 250 to 499 ms after the first attempt, 500 ms after the second at the floor, 4000 ms at the 8 s cap', () => {
    expect(nextWait({ attempt: 0, elapsedMs: 0, policy: lowest })).toEqual({ kind: 'wait', ms: 250 });
    expect(nextWait({ attempt: 0, elapsedMs: 0, policy: highest })).toEqual({ kind: 'wait', ms: 499 });
    expect(nextWait({ attempt: 1, elapsedMs: 0, policy: lowest })).toEqual({ kind: 'wait', ms: 500 });
    expect(nextWait({ attempt: 10, elapsedMs: 0, policy: lowest })).toEqual({ kind: 'wait', ms: 4000 });
  });

  it('waits max(backoff, retryAfterMs)', () => {
    expect(nextWait({ attempt: 0, retryAfterMs: 5000, elapsedMs: 0, policy: lowest })).toEqual({ kind: 'wait', ms: 5000 });
    expect(nextWait({ attempt: 0, retryAfterMs: 100, elapsedMs: 0, policy: lowest })).toEqual({ kind: 'wait', ms: 250 });
  });

  it('waits a Retry-After equal to retry.maxMs and leaves for one a millisecond longer', () => {
    expect(nextWait({ attempt: 0, retryAfterMs: 8000, elapsedMs: 0, policy: lowest })).toEqual({ kind: 'wait', ms: 8000 });
    expect(nextWait({ attempt: 0, retryAfterMs: 8001, elapsedMs: 0, policy: lowest })).toEqual({ kind: 'leave' });
  });

  it('leaves when elapsedMs + wait exceeds retry.totalWaitMs (84 s), and waits when it equals it', () => {
    expect(nextWait({ attempt: 0, elapsedMs: 83_750, policy: lowest })).toEqual({ kind: 'wait', ms: 250 });
    expect(nextWait({ attempt: 0, elapsedMs: 83_751, policy: lowest })).toEqual({ kind: 'leave' });
  });
});
