import { describe, expect, it } from 'vitest';
import type { BatchOutputFormatter } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const LIMIT = 300;
const RAW = Array.from({ length: 100 }, (_unused, index) => `raw-line-${String(index + 1).padStart(3, '0')}`).join('\n');
const NOTE = 'Note: the command finished (exit code 0) and its output is above. MomongaCode could not check whether a process started by it is still running (bwrap). Nothing was stopped.';

const headerOf = (handle: string): string => `[formatted by grep; raw output ${handle}; read it with ReadOutput]`;

const formatting = (seen: string[]): BatchOutputFormatter => ({ output }) => {
  seen.push(output);
  return { output: 'formatted view', formatter: 'grep', version: 1, header: headerOf };
};

const runWith = async (name: string, result: { output: string; notes?: string[] }, formatOutput: BatchOutputFormatter | undefined) => {
  const harness = makeHarness({ outputLimitChars: LIMIT });
  const set = await toolSetOf(makeTool(name, { kind: 'search', execute: async () => ({ status: 'completed', ...result }) }));
  const [outcome] = await harness.executor.runBatch(await harness.input(set, [call('c1', name)], formatOutput === undefined ? {} : { formatOutput }));
  if (outcome?.kind !== 'result') throw new Error('expected a result');
  return { harness, result: outcome.result };
};

describe('a product note is never part of the tool output that is formatted and stored under the handle', () => {
  it.each(['Grep', 'Bash', 'Glob'])('%s: the formatter sees only the tool output, and the note follows the formatted text', async (name) => {
    const seen: string[] = [];
    const { harness, result } = await runWith(name, { output: RAW, notes: [NOTE] }, formatting(seen));
    expect(seen).toEqual([RAW]);
    expect(result.handle).toBeDefined();
    expect(result.output).toBe(`${headerOf(result.handle as string)}\nformatted view\n${NOTE}`);
    expect(harness.blobs.stored.get(result.handle as string)?.text).toBe(RAW);
    expect(result.formatted).toEqual({ formatter: 'grep', version: 1 });
  });

  it.each(['Grep', 'Bash', 'Glob'])('%s: the stored raw output and its handle are the same with and without a note', async (name) => {
    const withNote = await runWith(name, { output: RAW, notes: [NOTE] }, formatting([]));
    const without = await runWith(name, { output: RAW }, formatting([]));
    expect(withNote.result.handle).toBe(without.result.handle);
    expect(withNote.harness.blobs.stored.get(withNote.result.handle as string)?.text).toBe(without.harness.blobs.stored.get(without.result.handle as string)?.text);
  });

  it('cuts an unformatted output over the fit without cutting the note, which follows the cut text', async () => {
    const { harness, result } = await runWith('Bash', { output: RAW, notes: [NOTE] }, undefined);
    expect(result.truncated).toBe(true);
    expect(harness.blobs.stored.get(result.handle as string)?.text).toBe(RAW);
    expect(result.output.endsWith(`\n${NOTE}`)).toBe(true);
  });

  it('gives an output that fits, with its notes, as the output followed by each note on its own line', async () => {
    const { result } = await runWith('Bash', { output: 'short', notes: ['first note', 'second note'] }, undefined);
    expect(result).toEqual({ status: 'completed', output: 'short\nfirst note\nsecond note' });
  });

  it('gives the note alone when the tool printed nothing', async () => {
    const { result } = await runWith('Bash', { output: '', notes: ['only note'] }, undefined);
    expect(result.output).toBe('only note');
  });
});
