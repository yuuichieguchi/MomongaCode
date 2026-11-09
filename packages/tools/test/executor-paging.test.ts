import { describe, expect, it } from 'vitest';
import type { CallOutputFit } from '@momonga/tools';
import { askingFit, call, callAnsweredBy, charFit, makeHarness, makeTool, toolSetOf } from './harness.ts';

const BUDGET = 500;

describe('executor output fit and self-paging tools', () => {
  it.each([200, 500, 12_345])('exposes the batch output fit with limit %s as ctx.outputFit', async (limit) => {
    const harness = makeHarness({ outputLimitChars: limit });
    const seen: CallOutputFit[] = [];
    const asked = askingFit(charFit(limit));
    const tool = makeTool('Probe', {
      execute: async (_input, ctx) => {
        seen.push(ctx.outputFit);
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch({ ...harness.input(await toolSetOf(tool), [call('c1', 'Probe')]), outputFit: asked.port });
    expect(seen).toHaveLength(1);
    expect(await callAnsweredBy(seen[0] as CallOutputFit, asked)).toEqual({ callId: 'c1', tool: 'Probe' });
  });

  it('does not truncate a pagesOutput tool whose output fits the port', async () => {
    const harness = makeHarness({ outputLimitChars: BUDGET });
    const output = `${'p'.repeat(BUDGET - 1)}\n`;
    const tool = makeTool('Pager', { pagesOutput: true, execute: async () => ({ status: 'completed', output }) });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Pager')]));
    expect(outcome).toEqual({ callId: 'c1', kind: 'result', idemKey: expect.any(String), result: { status: 'completed', output } });
    expect(harness.blobs.puts).toEqual([]);
  });

  it('cuts a pagesOutput tool through the port when its output does not fit', async () => {
    const harness = makeHarness({ outputLimitChars: BUDGET });
    const output = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    const tool = makeTool('Pager', { pagesOutput: true, execute: async () => ({ status: 'completed', output }) });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Pager')]));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', truncated: true } });
    const result = (outcome as { result: { output: string; handle: string } }).result;
    expect(result.output.length).toBeLessThanOrEqual(BUDGET);
    expect(harness.blobs.stored.get(result.handle)?.text).toBe(output);
  });
});
