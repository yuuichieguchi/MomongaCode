import { describe, expect, it } from 'vitest';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { runTeardown } from '../../src/process/teardown.ts';
import type { TeardownStep } from '../../src/process/teardown.ts';
import { START_MS, makeLogger } from './helpers.ts';

const RUNTIME_TEARDOWN_BUDGET_MS = 10_000;
const DEFAULT_MCP_CLOSE_GRACE_MS = 1_000;
const GROUP_POLL_INTERVAL_MS = 10;
const REAP_POLL_INTERVAL_MS = 25;
const PER_CONNECTION_CLOSE_MS = 8 * DEFAULT_MCP_CLOSE_GRACE_MS + 2 * GROUP_POLL_INTERVAL_MS + 4 * REAP_POLL_INTERVAL_MS;

describe('the mcp-pools teardown step at the default MCP close grace (design rev 7, R4)', () => {
  it('closes both pools, each taking its full per-connection bound, inside the fixed teardown budget', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const logger = makeLogger();
    const closeOnePool = (): Promise<void> => new Promise<void>((resolve) => timers.setTimeout(resolve, PER_CONNECTION_CLOSE_MS));
    const mcpPools: TeardownStep = {
      name: 'mcp-pools',
      run: async () => {
        await closeOnePool();
        await closeOnePool();
      },
    };
    let abandoned: string[] | undefined;
    void runTeardown({ steps: [mcpPools], budgetMs: RUNTIME_TEARDOWN_BUDGET_MS, clock, timers, logger }).then((names) => {
      abandoned = names;
    });
    await afterMicrotasks();
    clock.advance(PER_CONNECTION_CLOSE_MS);
    timers.advance(PER_CONNECTION_CLOSE_MS);
    await afterMicrotasks();
    clock.advance(PER_CONNECTION_CLOSE_MS);
    timers.advance(PER_CONNECTION_CLOSE_MS);
    await afterMicrotasks();

    expect(abandoned).toEqual([]);
  });
});
