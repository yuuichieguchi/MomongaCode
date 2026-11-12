import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { DRAIN_RESIDUE_MAX_BYTES, drainIncompleteNote, pumpOutput } from '../src/capture.ts';

const IDLE_MS = 1000;

const setup = () => {
  const timers = createFakeTimers(createFakeClock(0));
  const stream = new PassThrough();
  const received: Buffer[] = [];
  const pump = pumpOutput([stream], (_index, chunk) => received.push(chunk), timers);
  const text = (): string => Buffer.concat(received).toString('utf8');
  return { timers, stream, pump, text };
};

describe('the output of a child after it exited is read by one bounded reader', () => {
  it('reads to the end of a stream that ends, and calls it complete', async () => {
    const { stream, pump, text } = setup();
    stream.write('all\n');
    stream.end();

    expect(await pump.drainAfterExit(IDLE_MS)).toEqual({ complete: true });
    expect(text()).toBe('all\n');
  });

  it('keeps reading while a writer that outlives the exit sends a chunk within each idle gap', async () => {
    const { timers, stream, pump, text } = setup();
    const draining = pump.drainAfterExit(IDLE_MS);
    for (const chunk of ['a', 'b', 'c', 'd']) {
      await timers.advanceAsync(400);
      stream.write(chunk);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await timers.advanceAsync(400);
    stream.end();

    expect(await draining).toEqual({ complete: true });
    expect(text()).toBe('abcd');
  });

  it('stops after the idle gap without data and says the output may be incomplete', async () => {
    const { timers, stream, pump } = setup();
    stream.write('x');
    const draining = pump.drainAfterExit(IDLE_MS);
    await timers.advanceAsync(IDLE_MS);

    expect(await draining).toEqual({ complete: false, note: drainIncompleteNote({ kind: 'idle', idleMs: IDLE_MS }) });
    expect(drainIncompleteNote({ kind: 'idle', idleMs: IDLE_MS })).toBe(`Stopped reading output after ${IDLE_MS} ms without data; output may be incomplete.`);
  });

  it('stops when the output after the exit passes the byte bound, and says so', async () => {
    const { stream, pump } = setup();
    const draining = pump.drainAfterExit(IDLE_MS);
    stream.write(Buffer.alloc(DRAIN_RESIDUE_MAX_BYTES + 1, 0x61));

    expect(await draining).toEqual({ complete: false, note: drainIncompleteNote({ kind: 'bytes', maxBytes: DRAIN_RESIDUE_MAX_BYTES }) });
  });
});
