import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { DRAIN_RESIDUE_MAX_BYTES, drainIncompleteNote, pumpOutput } from '../src/capture.ts';
import { cfgNames } from '../../../test/formal/cfg-names.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const model = cfgNames(path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla'), 'OutputDrain');

const IDLE_MS = 1000;

type Step = 'chunk' | 'shortGap' | 'idleGap' | 'end' | 'flood';

const STEPS: readonly Step[] = ['chunk', 'shortGap', 'idleGap', 'end', 'flood'];

const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const traces = (length: number): Step[][] => {
  let all: Step[][] = [[]];
  for (let index = 0; index < length; index += 1) all = all.flatMap((trace) => STEPS.map((step) => [...trace, step]));
  return all;
};

const NOTES = new Set([drainIncompleteNote({ kind: 'idle', idleMs: IDLE_MS }), drainIncompleteNote({ kind: 'bytes', maxBytes: DRAIN_RESIDUE_MAX_BYTES })]);

describe('the bounded reader after the exit on the cases of specs/tla/OutputDrain.tla', () => {
  it('the design configuration checks the invariants these cases run', () => {
    expect(model.invariants).toEqual(expect.arrayContaining(['ByteLostImpliesNote', 'NonEofReleaseIsNoted', 'NoLossWithoutStall']));
    expect(model.properties).toContain('AlwaysReleased');
  });

  it('on every sequence of writes, gaps, a flood past the bound and the end of the pipe after the exit: the reader is released, every release that is not the end of the pipe carries a note, no byte written before the release is lost, and a writer that keeps each silence below the idle time is read to the end', async () => {
    const problems: string[] = [];
    for (const trace of traces(3)) {
      const timers = createFakeTimers(createFakeClock(0));
      const stream = new PassThrough();
      let received = 0;
      const pump = pumpOutput([stream], (_index, chunk) => {
        received += chunk.length;
      }, timers);
      let released: Awaited<ReturnType<typeof pump.drainAfterExit>> | undefined;
      const draining = pump.drainAfterExit(IDLE_MS).then((drained) => {
        released = drained;
        return drained;
      });
      let written = 0;
      let writtenAtRelease: number | undefined;
      let idleBroken = false;
      let silentMs = 0;
      let flooded = false;
      for (const step of trace) {
        if (released !== undefined) break;
        if (step === 'chunk') {
          stream.write('x');
          written += 1;
          silentMs = 0;
        } else if (step === 'flood') {
          stream.write(Buffer.alloc(DRAIN_RESIDUE_MAX_BYTES + 1, 0x61));
          written += DRAIN_RESIDUE_MAX_BYTES + 1;
          flooded = true;
        } else if (step === 'shortGap') {
          await timers.advanceAsync(IDLE_MS / 2);
          silentMs += IDLE_MS / 2;
          if (silentMs >= IDLE_MS) idleBroken = true;
        }
        else if (step === 'idleGap') {
          await timers.advanceAsync(IDLE_MS);
          idleBroken = true;
        } else stream.end();
        await turn();
        if (released !== undefined) writtenAtRelease = written;
        if (step === 'end') break;
      }
      if (released === undefined) {
        stream.end();
        await turn();
      }
      const drained = await draining;
      writtenAtRelease ??= written;
      const label = trace.join(',');
      if (!drained.complete && !NOTES.has(drained.note)) problems.push(`${label}: NonEofReleaseIsNoted, ${drained.note}`);
      if (drained.complete && received < writtenAtRelease) problems.push(`${label}: ByteLostImpliesNote, ${received} of ${writtenAtRelease} read and no note`);
      if (!drained.complete && !idleBroken && !flooded) problems.push(`${label}: released with ${drained.note} while each silence stayed below the idle time`);
      stream.end();
      await pump.ended();
    }
    expect(problems).toEqual([]);
  });

  it('the idle time runs only once the drain began: before it, a long silence does not end the reading', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const stream = new PassThrough();
    const chunks: string[] = [];
    const pump = pumpOutput([stream], (_index, chunk) => chunks.push(chunk.toString('utf8')), timers);
    await timers.advanceAsync(IDLE_MS * 10);
    stream.write('late');
    await turn();
    const draining = pump.drainAfterExit(IDLE_MS);
    stream.end();
    expect(await draining).toEqual({ complete: true });
    expect(chunks.join('')).toBe('late');
  });
});
