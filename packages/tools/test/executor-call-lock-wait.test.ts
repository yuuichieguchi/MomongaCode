import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReapTiming } from '@momonga/foundation';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');
const HOLDER_PID = 4242;
const LONG_LEASE_HEARTBEAT_MS = 40_000;
const ABORT_SETTLE_LIMIT_MS = 2000;
const SHORT_LEASE_HEARTBEAT_MS = 1000;
const FIXED_CAP_MS = 30_000;

const lockPathOf = (harness: Harness): string => path.join(harness.callLockDir, `${KEY}.lock`);

const advancingTiming = (onAdvance: (now: number) => void = () => undefined): ReapTiming => {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
      onAdvance(current);
    },
  };
};

const reconcilingEdit = () =>
  makeTool('Edit', {
    kind: 'edit',
    sideEffect: 'write',
    reconcile: async () => ({ outcome: 'already_applied', output: 'reconciled' }),
  });

const sourceOf = (relative: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', relative), 'utf8');

describe('the wait for a held call lock', () => {
  it('outlasts a long heartbeat plus the settle limit, whatever the reconcile cap is', async () => {
    let harness: Harness | undefined;
    const timing = advancingTiming((now) => {
      if (now >= LONG_LEASE_HEARTBEAT_MS + ABORT_SETTLE_LIMIT_MS) harness?.kernelLock.releaseExternally(lockPathOf(harness));
    });
    harness = makeHarness({ executor: { reap: { timing }, reconcileCapMs: FIXED_CAP_MS, heartbeatMs: LONG_LEASE_HEARTBEAT_MS } as never });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    const outcomes = await harness.executor.runBatch(harness.input(await toolSetOf(reconcilingEdit()), [call('c1', 'Edit', {}, 'allow_once')]));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ kind: 'result', result: { status: 'completed' } });
  });

  it('follows a short heartbeat down instead of sitting out the reconcile cap', async () => {
    const harness = makeHarness({ executor: { reap: { timing: advancingTiming() }, reconcileCapMs: FIXED_CAP_MS, heartbeatMs: SHORT_LEASE_HEARTBEAT_MS } as never });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    const failure: unknown = await harness.executor.runBatch(harness.input(await toolSetOf(reconcilingEdit()), [call('c1', 'Edit', {}, 'allow_once')])).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'earlier_attempt_not_stopped' });
    const waited = Number(/after (\d+) ms/.exec((failure as Error).message)?.[1]);
    expect(waited).toBeGreaterThanOrEqual(SHORT_LEASE_HEARTBEAT_MS + ABORT_SETTLE_LIMIT_MS);
    expect(waited).toBeLessThan(FIXED_CAP_MS);
  });

  it('receives the heartbeat of the configured lease in the runtime process', () => {
    expect(sourceOf('runtime/src/process/tool-runtime.ts')).toMatch(/createToolExecutor\(\{[^}]*heartbeatMs/s);
    expect(sourceOf('runtime/src/process/start-runtime-process.ts')).toMatch(/createToolRuntime\(\{[^}]*heartbeatMs/s);
  });
});
