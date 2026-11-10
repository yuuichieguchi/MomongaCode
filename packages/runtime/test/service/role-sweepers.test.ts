import { describe, expect, it } from 'vitest';
import { mutableRole } from '../shared/mutable-role.ts';
import { startService } from './helpers.ts';

const SWEEP_MS = 7_000;
const POLL_MS = 1_000;

const sweeperTimers = (env: Awaited<ReturnType<typeof startService>>): number =>
  (env.timers?.pending() ?? []).filter((timer) => timer.delayMs === SWEEP_MS).length;

describe('the sweepers of the service by role (17.2, 20.2, 20.32)', () => {
  it('arms no sweeper and releases no stopped run while starting, and keeps the data-version poll', async () => {
    const released: string[] = [];
    const role = mutableRole('starting');
    const env = await startService({ fakeTimers: true, role: role.port, sweepIntervalMs: SWEEP_MS, releaseStopped: async (runId) => void released.push(runId) });

    expect(sweeperTimers(env)).toBe(0);
    expect((env.timers?.pending() ?? []).filter((timer) => timer.delayMs === POLL_MS)).toHaveLength(1);
    expect(released).toEqual([]);
  });

  it('arms the approval, terminal and search sweepers when the role becomes serving, once', async () => {
    const role = mutableRole('starting');
    const env = await startService({ fakeTimers: true, role: role.port, sweepIntervalMs: SWEEP_MS });

    role.set('serving');
    env.service.applyRole();
    env.service.applyRole();

    expect(sweeperTimers(env)).toBe(3);
  });

  it('stops the three sweepers when the role becomes retiring, and the data-version poll goes on', async () => {
    const role = mutableRole('serving');
    const env = await startService({ fakeTimers: true, role: role.port, sweepIntervalMs: SWEEP_MS });
    expect(sweeperTimers(env)).toBe(3);

    role.set('retiring');
    env.service.applyRole();
    await expect.poll(() => sweeperTimers(env)).toBe(0);

    expect((env.timers?.pending() ?? []).filter((timer) => timer.delayMs === POLL_MS)).toHaveLength(1);
  });
});
