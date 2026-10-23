import { describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { blobHandle } from './helpers.ts';

const LINES = Array.from({ length: 100 }, (_unused, index) => `line-${String(index + 1).padStart(3, '0')}`);
const FULL = LINES.join('\n');

const run = async (output: string, maxInlineOutputChars = 200) => {
  const harness = makeHarness({ maxInlineOutputChars });
  const set = await toolSetOf(makeTool('Read', { execute: async () => ({ status: 'completed', output }) }));
  const first = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
  const outcome = first[0];
  if (outcome?.kind !== 'result') throw new Error('expected result');
  return { harness, set, first, result: outcome.result };
};

describe('output truncation', () => {
  it('returns output at or below the limit unchanged and stores nothing', async () => {
    const exact = 'x'.repeat(200);
    const { harness, result } = await run(exact);
    expect(result).toEqual({ status: 'completed', output: exact });
    expect(harness.blobs.puts).toEqual([]);
  });

  it('stores the full output in a blob and returns head, marker and tail within the limit', async () => {
    expect(FULL.length).toBe(899);
    const { harness, result } = await run(FULL);
    expect(harness.blobs.puts).toEqual([{ handle: blobHandle(1), mediaType: 'text/plain; charset=utf-8' }]);
    expect(harness.blobs.stored.get(blobHandle(1))?.text).toBe(FULL);
    expect(result.truncated).toBe(true);
    expect(result.handle).toBe(blobHandle(1));
    expect(result.status).toBe('completed');
    expect(result.output.length).toBeLessThanOrEqual(200);
    expect(result.output.startsWith('line-001\n')).toBe(true);
    expect(result.output.endsWith('\nline-100')).toBe(true);
    expect(result.output).toContain(blobHandle(1));
    expect(result.output).toContain('ReadOutput');
  });

  it('splits on line boundaries and names the omitted line count', async () => {
    const { result } = await run(FULL);
    const outputLines = result.output.split('\n');
    const kept = outputLines.filter((line) => /^line-\d{3}$/.test(line));
    const keptNumbers = kept.map((line) => Number(line.slice(5)));
    const markerLines = outputLines.filter((line) => !/^line-\d{3}$/.test(line));
    expect(markerLines.length).toBeGreaterThan(0);
    const headCount = keptNumbers.findIndex((value, index) => value !== index + 1);
    expect(headCount).toBeGreaterThan(0);
    const tail = keptNumbers.slice(headCount);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail).toEqual(Array.from({ length: tail.length }, (_unused, index) => 101 - tail.length + index));
    const omitted = 100 - kept.length;
    expect(markerLines.join('\n')).toMatch(new RegExp(`\\b${omitted}\\b`));
  });

  it('keeps truncated failed results failed', async () => {
    const harness = makeHarness({ maxInlineOutputChars: 200 });
    const set = await toolSetOf(makeTool('Read', { execute: async () => ({ status: 'failed', output: FULL }) }));
    const [outcome] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed', truncated: true, handle: blobHandle(1) } });
  });

  it('defaults the inline limit to 30000 characters', async () => {
    const atLimit = `${'a'.repeat(29_999)}\n`;
    const harness = makeHarness();
    const set = await toolSetOf(
      makeTool('Read', {
        inputSchema: { type: 'object', properties: { big: { type: 'boolean' } }, additionalProperties: false },
        execute: async (input) => ({ status: 'completed', output: input['big'] === true ? `${atLimit}b` : atLimit }),
      }),
    );
    const outcomes = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read', { big: false }), call('c2', 'Read', { big: true })]));
    expect(outcomes[0]).toMatchObject({ result: { output: atLimit } });
    expect(outcomes[0]?.kind === 'result' ? outcomes[0].result.truncated : 'missing').toBeUndefined();
    expect(outcomes[1]).toMatchObject({ result: { truncated: true } });
    expect(harness.blobs.puts).toHaveLength(1);
  });

  it('replays a truncated result identically without storing another blob', async () => {
    const { harness, set, first } = await run(FULL);
    const second = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    expect(second).toEqual(first);
    expect(harness.blobs.puts).toHaveLength(1);
  });
});
