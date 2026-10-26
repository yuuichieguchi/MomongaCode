import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { blobHandle } from './helpers.ts';

const LINES = Array.from({ length: 100 }, (_unused, index) => `line-${String(index + 1).padStart(3, '0')}`);
const FULL = LINES.join('\n');

const recordingTool = (budgets: number[]) =>
  makeTool('Read', {
    execute: async (_input, ctx: ToolContext) => {
      budgets.push(ctx.outputBudgetChars);
      return { status: 'completed', output: FULL };
    },
  });

describe('per-batch inline limit', () => {
  it('truncates to the batch limit when it is below the executor default', async () => {
    const harness = makeHarness({ maxInlineOutputChars: 1000 });
    const budgets: number[] = [];
    const set = await toolSetOf(recordingTool(budgets));
    const [outcome] = await harness.executor.runBatch({ ...harness.input(set, [call('c1', 'Read')]), inlineLimitForReconcile: 200 });
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.result.truncated).toBe(true);
    expect(outcome.result.handle).toBe(blobHandle(1));
    expect(outcome.result.output.length).toBeLessThanOrEqual(200);
    expect(budgets).toEqual([200]);
  });

  it('keeps output inline when the batch limit is above the executor default', async () => {
    const harness = makeHarness({ maxInlineOutputChars: 200 });
    const budgets: number[] = [];
    const set = await toolSetOf(recordingTool(budgets));
    const [outcome] = await harness.executor.runBatch({ ...harness.input(set, [call('c1', 'Read')]), inlineLimitForReconcile: 1000 });
    expect(outcome).toEqual({ callId: 'c1', kind: 'result', result: { status: 'completed', output: FULL }, idemKey: expect.any(String) });
    expect(harness.blobs.puts).toEqual([]);
    expect(budgets).toEqual([1000]);
  });

  it('uses the executor default when the batch sets no limit', async () => {
    const harness = makeHarness({ maxInlineOutputChars: 1000 });
    const budgets: number[] = [];
    const set = await toolSetOf(recordingTool(budgets));
    const [outcome] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.result.output).toBe(FULL);
    expect(budgets).toEqual([1000]);
  });
});
