import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks, waitFor } from '@momonga/testkit';
import { launchRuntime, startStack, waitForStatus } from './run-helpers.ts';
import type { Stack } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const RUNTIME_RESOURCE_KINDS = new Set(['Timeout', 'PipeServerWrap', 'PipeWrap', 'ProcessWrap']);

const counts = (): Map<string, number> => {
  const result = new Map<string, number>();
  for (const kind of process.getActiveResourcesInfo()) if (RUNTIME_RESOURCE_KINDS.has(kind)) result.set(kind, (result.get(kind) ?? 0) + 1);
  return result;
};

const excess = (baseline: Map<string, number>): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const [kind, count] of counts()) {
    const extra = count - (baseline.get(kind) ?? 0);
    if (extra > 0) result[kind] = extra;
  }
  return result;
};

const runOnce = async (stack: Stack): Promise<void> => {
  const launched = await launchRuntime(stack.temp);
  const session = await launched.createSession();
  const run = await launched.createRun(session.id);
  expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED', 'CANCELLED'])).toBe('COMPLETED');
  launched.client.close();
  expect(await launched.handle.close()).toEqual({ clean: true, abandoned: [], stragglers: [] });
};

describe('leak contract (system timers, in-process gateway)', () => {
  it('leaves no runtime-created handles after a clean close', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    await runOnce(stack);
    await afterMicrotasks();
    const baseline = counts();
    await runOnce(stack);
    await waitFor(() => Object.keys(excess(baseline)).length === 0, { maxTurns: 5000, description: 'runtime handles to be released' });
    expect(excess(baseline)).toEqual({});
  });
});
