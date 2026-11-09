import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { START_MS } from '../process/helpers.ts';
import { FIVE_MINUTES_MS, HOUR_MS, STORE_IDENTITY_CHECK_MS, launchRuntime, startStack } from '../process/run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const SWEEPER_INTERVALS = [HOUR_MS, FIVE_MINUTES_MS, STORE_IDENTITY_CHECK_MS];

type Retiring = { retire(): Promise<void> };

const sweeperTimers = (timers: FakeTimers): number[] =>
  timers
    .pending()
    .map((timer) => timer.delayMs)
    .filter((delay) => SWEEPER_INTERVALS.includes(delay))
    .sort((a, b) => a - b);

describe('H2: only the serving generation runs the periodic sweepers', () => {
  it('stops every periodic sweeper when the runtime becomes retiring, and keeps serving its socket', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers });
    expect(sweeperTimers(timers)).toEqual(expect.arrayContaining([STORE_IDENTITY_CHECK_MS, FIVE_MINUTES_MS, HOUR_MS]));
    await (launched.handle as typeof launched.handle & Retiring).retire();
    expect(sweeperTimers(timers)).toEqual([]);
    const health = await launched.http('GET', '/v1/health');
    expect(health.status).toBe(200);
  });
});
