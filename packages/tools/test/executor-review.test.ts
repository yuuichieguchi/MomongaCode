import { afterEach, describe, expect, it } from 'vitest';
import { createToolExecutor } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { makeBlobs, makeClock, makeIdempotency } from './helpers.ts';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const LONGEST_MARKER = `[${'9'.repeat(16)} lines omitted; full output saved as ${'f'.repeat(64)}; read it with the ReadOutput tool]`;
const MINIMUM_LIMIT = LONGEST_MARKER.length + 2 + 2;

const construct = (maxInlineOutputChars: number) => {
  const clock = makeClock();
  return createToolExecutor({ idempotency: makeIdempotency(clock).port, blobs: makeBlobs().port, clock, maxInlineOutputChars, processMarkerDir: '/nonexistent-marker-dir' });
};

const truncatedOutput = async (output: string, limit: number): Promise<{ output: string; truncated?: true }> => {
  const harness = makeHarness({ maxInlineOutputChars: limit });
  const set = await toolSetOf(makeTool('Read', { execute: async () => ({ status: 'completed', output }) }));
  const [outcome] = await harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
  if (outcome?.kind !== 'result') throw new Error('expected result');
  return outcome.result;
};

describe('batch failure propagation', () => {
  const listeners: Array<(reason: unknown) => void> = [];
  afterEach(() => {
    for (const listener of listeners.splice(0)) process.off('unhandledRejection', listener);
  });

  it.each(['blobs.put', 'idempotency.complete'] as const)('rejects runBatch without an unhandled rejection when %s throws under the limiter', async (where) => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    listeners.push(listener);
    process.on('unhandledRejection', listener);
    const harness = makeHarness({ maxParallel: 1 });
    const failure = new Error(`${where} exploded`);
    if (where === 'blobs.put') {
      harness.blobs.port.put = () => {
        throw failure;
      };
    } else {
      harness.idempotency.port.complete = () => {
        throw failure;
      };
    }
    const tool = makeTool('Read', { execute: async (_input, ctx) => ({ status: 'completed', output: ctx.callId === 'c1' ? 'x'.repeat(30_001) : 'small' }) });
    const set = await toolSetOf(tool);
    await expect(harness.executor.runBatch(harness.input(set, [call('c1', 'Read'), call('c2', 'Read')]))).rejects.toBe(failure);
    for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  });
});

describe('truncation limits', () => {
  it('rejects a limit too small for the marker plus one head and one tail character', () => {
    expect(() => construct(MINIMUM_LIMIT - 1)).toThrow();
    expect(() => construct(1)).toThrow();
    expect(() => construct(MINIMUM_LIMIT)).not.toThrow();
  });

  it('never splits a surrogate pair', async () => {
    const result = await truncatedOutput('😀'.repeat(400), 300);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(300);
    expect(LONE_SURROGATE.test(result.output)).toBe(false);
    expect(result.output.startsWith('😀')).toBe(true);
    expect(result.output.endsWith('😀')).toBe(true);
  });

  const inputs: Array<[string, string]> = [
    ['ascii lines', Array.from({ length: 400 }, (_unused, index) => `row ${index}`).join('\n')],
    ['one long ascii line', 'a'.repeat(5000)],
    ['one long emoji line', '😀'.repeat(3000)],
    ['emoji lines', Array.from({ length: 300 }, () => '😀a😀').join('\n')],
    ['only newlines', '\n'.repeat(4000)],
    ['odd surrogate offsets', `b${'😀'.repeat(2500)}`],
  ];
  const limits = [MINIMUM_LIMIT, MINIMUM_LIMIT + 1, MINIMUM_LIMIT + 2, 257, 401, 1000];

  for (const limit of limits) {
    it.each(inputs)(`keeps %s within a limit of ${limit} and well formed`, async (_label, output) => {
      const result = await truncatedOutput(output, limit);
      expect(result.truncated).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(limit);
      expect(LONE_SURROGATE.test(result.output)).toBe(false);
    });
  }
});

describe('blob handle contract', () => {
  const listeners: Array<(reason: unknown) => void> = [];
  afterEach(() => {
    for (const listener of listeners.splice(0)) process.off('unhandledRejection', listener);
  });

  it.each([
    ['longer', 'a'.repeat(65)],
    ['shorter', 'a'.repeat(63)],
    ['uppercase', 'A'.repeat(64)],
    ['non-hex characters', `${'a'.repeat(60)}xyz!`],
    ['a path-like value', `../${'a'.repeat(61)}`],
  ])('rejects runBatch when the blob handle is %s', async (_label, handle) => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    listeners.push(listener);
    process.on('unhandledRejection', listener);
    const harness = makeHarness({ maxInlineOutputChars: 300 });
    harness.blobs.port.put = (data) => ({ handle, sha256: 'a'.repeat(64), byteLength: String(data).length, lineCount: 1 });
    const set = await toolSetOf(makeTool('Read', { execute: async () => ({ status: 'completed', output: 'z'.repeat(1000) }) }));
    const outcome = harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    await expect(outcome).rejects.toThrow(/handle/i);
    await expect(outcome).rejects.toThrow(/64/);
    for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  });
});
