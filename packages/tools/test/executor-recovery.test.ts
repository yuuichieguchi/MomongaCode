import { describe, expect, it } from 'vitest';
import type { ToolIdempotencyRecord } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');
const STORED = { path: '/stored', preHash: 'pre', postHash: 'post' };
const FRESH = { path: '/fresh', preHash: 'fresh-pre', postHash: 'fresh-post' };

const recordingTool = (outcome: 'already_applied' | 'not_applied' | 'unknown') => {
  const seen = { prepares: 0, reconciled: [] as ToolIdempotencyRecord[], executed: [] as Array<Record<string, unknown> | undefined> };
  const tool = makeTool('Edit', {
    kind: 'edit',
    sideEffect: 'write',
    prepare: async () => {
      seen.prepares += 1;
      return FRESH;
    },
    reconcile: async (_input, record) => {
      seen.reconciled.push(record);
      return { outcome, output: `reconciled ${outcome}` };
    },
    execute: async (_input, _ctx, prepared) => {
      seen.executed.push(prepared);
      return { status: 'completed', output: 'executed' };
    },
  });
  return { tool, seen };
};

describe('executor recovery of an interrupted call', () => {
  it.each(['PENDING', 'UNKNOWN'] as const)('skips prepare and reconciles from the stored prepared meta of a %s record', async (state) => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, state, { tool: 'Edit', prepared: STORED });
    const { tool, seen } = recordingTool('already_applied');
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied', result: { status: 'completed', output: 'reconciled already_applied' } });
    expect(seen.prepares).toBe(0);
    expect(seen.reconciled.map((record) => record.meta)).toEqual([{ tool: 'Edit', prepared: STORED }]);
    expect(seen.executed).toEqual([]);
  });

  it('re-executes a not_applied call with the stored prepared meta', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit', prepared: STORED });
    const { tool, seen } = recordingTool('not_applied');
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'not_applied', result: { status: 'completed', output: 'executed' } });
    expect(seen.prepares).toBe(0);
    expect(seen.executed).toEqual([STORED]);
  });

  it('reports unknown without preparing or executing', async () => {
    const harness = makeHarness();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit', prepared: STORED });
    const { tool, seen } = recordingTool('unknown');
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
    expect(seen.prepares).toBe(0);
    expect(seen.executed).toEqual([]);
  });

  it('runs prepare and passes its result to execute when there is no record', async () => {
    const harness = makeHarness();
    const { tool, seen } = recordingTool('unknown');
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Edit', {}, 'allow_once')]));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'executed' } });
    expect(seen.prepares).toBe(1);
    expect(seen.reconciled).toEqual([]);
    expect(seen.executed).toEqual([FRESH]);
    expect(harness.idempotency.log.find((entry) => entry.op === 'begin')).toMatchObject({ meta: { tool: 'Edit', prepared: FRESH } });
  });
});
