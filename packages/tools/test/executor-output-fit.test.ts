import { describe, expect, it } from 'vitest';
import type { CallOutputFit, ExecutionBatchInput, ToolContext } from '@momonga/tools';
import { askingFit, call, callAnsweredBy, makeHarness, makeTool, toolSetOf } from './harness.ts';

const FULL = Array.from({ length: 100 }, (_unused, index) => `line-${String(index + 1).padStart(3, '0')}`).join('\n');

const LIMIT = 200;

const fitPort = () => {
  const cuts: { text: string; handle: string }[] = [];
  return {
    cuts,
    port: {
      fits: async (text: string): Promise<boolean> => text.length <= LIMIT,
      fit: async (text: string, handle: string): Promise<string> => {
        cuts.push({ text, handle });
        return text.length <= LIMIT ? text : `${text.slice(0, 40)}\n[cut; ${handle}]`;
      },
    },
  };
};

describe('the executor cuts a tool output through the output fit port', () => {
  it('cuts a long output through the port and records the raw output behind the handle', async () => {
    const harness = makeHarness();
    const { port } = fitPort();
    const tool = makeTool('Probe', { execute: async () => ({ status: 'completed', output: FULL }) });
    const [outcome] = await harness.executor.runBatch({ ...(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')])), outputFit: port });
    if (outcome?.kind !== 'result') throw new Error('expected a result');
    const handle = outcome.result.handle as string;
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.result.truncated).toBe(true);
    expect(outcome.result.output).toBe(`${FULL.slice(0, 40)}\n[cut; ${handle}]`);
    expect(harness.blobs.stored.get(handle)?.text).toBe(FULL);
  });

  it('keeps an output the port says fits inline however many characters it has, stores no blob and adds no marker', async () => {
    const harness = makeHarness();
    const long = Array.from({ length: 4000 }, (_unused, index) => `row ${index} of a wide listing`).join('\n');
    const port = { fits: async (): Promise<boolean> => true, fit: async (text: string): Promise<string> => text };
    const tool = makeTool('Probe', { execute: async () => ({ status: 'completed', output: long }) });
    const [outcome] = await harness.executor.runBatch({ ...(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')])), outputFit: port });
    expect(long.length).toBeGreaterThan(100_000);
    expect(outcome).toEqual({ callId: 'c1', kind: 'result', idemKey: expect.any(String), result: { status: 'completed', output: long } });
    expect(harness.blobs.puts).toEqual([]);
  });

  it('hands the same port to the tool as ctx.outputFit', async () => {
    const harness = makeHarness();
    const asked = askingFit(fitPort().port);
    const seen: CallOutputFit[] = [];
    const tool = makeTool('Probe', {
      execute: async (_input, ctx: ToolContext) => {
        seen.push(ctx.outputFit);
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch({ ...(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')])), outputFit: asked.port });
    expect(seen).toHaveLength(1);
    expect(await callAnsweredBy(seen[0] as CallOutputFit, asked)).toEqual({ callId: 'c1', tool: 'Probe' });
  });

  it('refuses to run an output-producing tool without a fit port instead of falling back to a default length', async () => {
    const harness = makeHarness();
    const tool = makeTool('Probe', { execute: async () => ({ status: 'completed', output: FULL }) });
    const { outputFit: _none, ...bare } = (await harness.input(await toolSetOf(tool), [call('c1', 'Probe')])) as ExecutionBatchInput & { outputFit?: unknown };
    await expect(harness.executor.runBatch(bare as ExecutionBatchInput)).rejects.toThrow(/outputFit/);
  });
});
