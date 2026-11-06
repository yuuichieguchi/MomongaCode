import { describe, expect, it } from 'vitest';
import type { OutputFit, ToolContext } from '@momonga/tools';
import { call, charFit, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { blobHandle } from './helpers.ts';

const LINES = Array.from({ length: 100 }, (_unused, index) => `line-${String(index + 1).padStart(3, '0')}`);
const FULL = LINES.join('\n');

const recordingTool = (ports: OutputFit[]) =>
  makeTool('Read', {
    execute: async (_input, ctx: ToolContext) => {
      ports.push(ctx.outputFit);
      return { status: 'completed', output: FULL };
    },
  });

describe('per-batch output fit', () => {
  it('cuts through the batch port when it is tighter than the harness default', async () => {
    const harness = makeHarness({ outputLimitChars: 1000 });
    const ports: OutputFit[] = [];
    const set = await toolSetOf(recordingTool(ports));
    const tight = charFit(200);
    const [outcome] = await harness.executor.runBatch({ ...harness.input(set, [call('c1', 'Read')]), outputFit: tight });
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.result.truncated).toBe(true);
    expect(outcome.result.handle).toBe(blobHandle(1));
    expect(outcome.result.output.length).toBeLessThanOrEqual(200);
    expect(ports).toEqual([tight]);
  });

  it('keeps output inline when the batch port is looser than the harness default', async () => {
    const harness = makeHarness({ outputLimitChars: 200 });
    const ports: OutputFit[] = [];
    const set = await toolSetOf(recordingTool(ports));
    const loose = charFit(1000);
    const [outcome] = await harness.executor.runBatch({ ...harness.input(set, [call('c1', 'Read')]), outputFit: loose });
    expect(outcome).toEqual({ callId: 'c1', kind: 'result', result: { status: 'completed', output: FULL }, idemKey: expect.any(String) });
    expect(harness.blobs.puts).toEqual([]);
    expect(ports).toEqual([loose]);
  });

  it('cuts through the port the batch was given, not through any default', async () => {
    const harness = makeHarness({ outputLimitChars: 1000 });
    const ports: OutputFit[] = [];
    const set = await toolSetOf(recordingTool(ports));
    const [outcome] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.result.output).toBe(FULL);
    expect(ports).toHaveLength(1);
  });
});
