import { describe, expect, it } from 'vitest';
import type { BatchOutputFormatter } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { blobHandle } from './helpers.ts';

const LIMIT = 300;
const WIDE_LIMIT = 700;

const headerOf = (formatter: string) => (handle: string): string => `[formatted by ${formatter}; raw output ${handle}; read it with ReadOutput]`;
const RAW = Array.from({ length: 100 }, (_unused, index) => `raw-line-${String(index + 1).padStart(3, '0')}`).join('\n');
const SHORT_RAW = 'short raw output';

type Seen = Parameters<BatchOutputFormatter>[0];

const runWith = async (output: string, formatOutput: BatchOutputFormatter | undefined, limit: number = LIMIT) => {
  const harness = makeHarness({ outputLimitChars: limit });
  const set = await toolSetOf(makeTool('Grep', { kind: 'search', execute: async () => ({ status: 'completed', output }) }));
  const [outcome] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Grep')], formatOutput === undefined ? {} : { formatOutput }));
  if (outcome?.kind !== 'result') throw new Error('expected a result');
  return { harness, result: outcome.result };
};

describe('the batch output formatter in finalizeResult', () => {
  it('receives the whole raw output before the inline cut, with the tool name, kind and status', async () => {
    const seen: Seen[] = [];
    await runWith(RAW, (input) => {
      seen.push(input);
      return undefined;
    });
    expect(seen).toEqual([{ output: RAW, status: 'completed', tool: { name: 'Grep', kind: 'search' } }]);
  });

  it('returns one header line naming the formatter and the raw handle, then the formatted text, and stores the raw output even when it fits inline', async () => {
    const { harness, result } = await runWith(RAW, () => ({ output: 'formatted view', formatter: 'grep', version: 1, header: headerOf('grep') }));
    const [header, ...rest] = result.output.split('\n');
    expect(header).toContain('grep');
    expect(header).toContain(blobHandle(1));
    expect(rest.join('\n')).toBe('formatted view');
    expect(result.output).toBe(`${header as string}\nformatted view`);
    expect(result.truncated).toBe(false);
    expect(result.handle).toBe(blobHandle(1));
    expect(harness.blobs.stored.get(blobHandle(1))?.text).toBe(RAW);
    expect(harness.blobs.puts).toHaveLength(1);
    expect(result.formatted).toEqual({ formatter: 'grep', version: 1 });
  });

  it('stores the raw output of a result that fits inline and was formatted, so ReadOutput returns it byte for byte (T4-4)', async () => {
    const inlineRaw = RAW.split('\n').slice(0, 20).join('\n');
    expect(inlineRaw.length).toBeLessThanOrEqual(LIMIT);
    const { harness, result } = await runWith(inlineRaw, () => ({ output: 'short', formatter: 'log', version: 2, header: headerOf('log') }));
    const [header, ...rest] = result.output.split('\n');
    expect(header).toContain('log');
    expect(header).toContain(blobHandle(1));
    expect(rest.join('\n')).toBe('short');
    expect(result.truncated).toBe(false);
    expect(result.handle).toBe(blobHandle(1));
    expect(harness.blobs.stored.get(blobHandle(1))?.text).toBe(inlineRaw);
    expect(result.formatted).toEqual({ formatter: 'log', version: 2 });
  });

  it('cuts a formatted text over the output fit with a marker naming the same raw handle, storing one blob', async () => {
    const formattedText = Array.from({ length: 80 }, (_unused, index) => `formatted-${String(index + 1).padStart(3, '0')}`).join('\n');
    const { harness, result } = await runWith(RAW, () => ({ output: formattedText, formatter: 'grep', version: 1, header: headerOf('grep') }), WIDE_LIMIT);
    expect(harness.blobs.puts).toHaveLength(1);
    expect(harness.blobs.stored.get(blobHandle(1))?.text).toBe(RAW);
    expect(result.handle).toBe(blobHandle(1));
    expect(result.output.length).toBeLessThanOrEqual(WIDE_LIMIT);
    const lines = result.output.split('\n');
    expect(lines[0]).toContain('grep');
    expect(lines[0]).toContain(blobHandle(1));
    expect(lines[1]).toBe('formatted-001');
    expect(result.output.endsWith('\nformatted-080')).toBe(true);
    expect(result.output).toContain(blobHandle(1));
    expect(result.output).toContain('ReadOutput');
    expect(result.output).not.toContain('raw-line-');
    expect(result.formatted).toEqual({ formatter: 'grep', version: 1 });
  });

  it('keeps the existing behaviour when the formatter declines, as when the batch passes none', async () => {
    let calls = 0;
    const declined = await runWith(SHORT_RAW, () => {
      calls += 1;
      return undefined;
    });
    const unformatted = await runWith(SHORT_RAW, undefined);
    expect(calls).toBe(1);
    expect(declined.result).toEqual({ status: 'completed', output: SHORT_RAW });
    expect(declined.harness.blobs.puts).toEqual([]);
    expect(unformatted.result).toEqual(declined.result);
  });

  it('uses the raw output when the formatter throws', async () => {
    let calls = 0;
    const { harness, result } = await runWith(SHORT_RAW, () => {
      calls += 1;
      throw new Error('formatter broke');
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ status: 'completed', output: SHORT_RAW });
    expect(harness.blobs.puts).toEqual([]);
  });
});
