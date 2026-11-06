import { afterEach, describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

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
    const harness = makeHarness({ outputLimitChars: 300 });
    harness.blobs.port.put = (data) => ({ handle, sha256: 'a'.repeat(64), byteLength: String(data).length, lineCount: 1 });
    const set = await toolSetOf(makeTool('Read', { execute: async () => ({ status: 'completed', output: 'z'.repeat(1000) }) }));
    const outcome = harness.executor.runBatch(harness.input(set, [call('c1', 'Read')]));
    await expect(outcome).rejects.toThrow(/handle/i);
    await expect(outcome).rejects.toThrow(/64/);
    for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  });
});
