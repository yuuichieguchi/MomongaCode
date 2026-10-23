import { describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const BUDGET = 500;

describe('executor output budget and self-paging tools', () => {
  it.each([undefined, 500, 12_345])('exposes maxInlineOutputChars %s as ctx.outputBudgetChars', async (limit) => {
    const harness = makeHarness(limit === undefined ? {} : { maxInlineOutputChars: limit });
    const seen: number[] = [];
    const tool = makeTool('Probe', {
      execute: async (_input, ctx) => {
        seen.push(ctx.outputBudgetChars);
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Probe')]));
    expect(seen).toEqual([limit ?? 30_000]);
  });

  it('does not truncate a pagesOutput tool whose output fits the budget', async () => {
    const harness = makeHarness({ maxInlineOutputChars: BUDGET });
    const output = `${'p'.repeat(BUDGET - 1)}\n`;
    const tool = makeTool('Pager', { pagesOutput: true, execute: async () => ({ status: 'completed', output }) });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Pager')]));
    expect(outcome).toEqual({ callId: 'c1', kind: 'result', idemKey: expect.any(String), result: { status: 'completed', output } });
    expect(harness.blobs.puts).toEqual([]);
  });

  it('falls back to blob truncation when a pagesOutput tool exceeds the budget', async () => {
    const harness = makeHarness({ maxInlineOutputChars: BUDGET });
    const output = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    const tool = makeTool('Pager', { pagesOutput: true, execute: async () => ({ status: 'completed', output }) });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Pager')]));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', truncated: true } });
    const result = (outcome as { result: { output: string; handle: string } }).result;
    expect(result.output.length).toBeLessThanOrEqual(BUDGET);
    expect(harness.blobs.stored.get(result.handle)?.text).toBe(output);
  });
});
