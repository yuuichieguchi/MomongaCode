import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReapMarkerDirectoryOptions, ReapMarkerDirectoryResult } from '@momonga/foundation';
import { afterMicrotasks, withTempDir } from '@momonga/testkit';
import { holdReapOfDirectory } from './reap-hold.ts';

const RESULT: ReapMarkerDirectoryResult = { reaped: 1, kept: 0, unreaped: [] };

const optionsFor = (dir: string, signal: AbortSignal): ReapMarkerDirectoryOptions => ({
  dir,
  killGraceMs: 2000,
  label: 'daemon',
  onWarning: () => undefined,
  signal,
  inspector: {} as ReapMarkerDirectoryOptions['inspector'],
});

const settledSoon = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await afterMicrotasks();
  return settled;
};

describe('holdReapOfDirectory', () => {
  it('announces the reap of the held directory and starts it only when the reap is stopped', async (context) => {
    const dir = withTempDir(context);
    const announce = path.join(dir, 'held');
    const calls: string[] = [];
    const reap = holdReapOfDirectory(async (options) => {
      calls.push(options.dir);
      return RESULT;
    }, { markersDir: path.join(dir, 'g1'), announce });
    const stop = new AbortController();
    const reaping = reap(optionsFor(path.join(dir, 'g1'), stop.signal));
    expect(await settledSoon(reaping)).toBe(false);
    expect(fs.readFileSync(announce, 'utf8')).toBe(`${path.join(dir, 'g1')}\n`);
    expect(calls).toEqual([]);
    stop.abort(new Error('shutdown'));
    expect(await reaping).toBe(RESULT);
    expect(calls).toEqual([path.join(dir, 'g1')]);
  });

  it('passes the reap of every other directory through without a hold', async (context) => {
    const dir = withTempDir(context);
    const announce = path.join(dir, 'held');
    const reap = holdReapOfDirectory(async () => RESULT, { markersDir: path.join(dir, 'g1'), announce });
    expect(await reap(optionsFor(path.join(dir, 'g2'), new AbortController().signal))).toBe(RESULT);
    expect(fs.existsSync(announce)).toBe(false);
  });

  it('holds only the first reap of the held directory', async (context) => {
    const dir = withTempDir(context);
    const reap = holdReapOfDirectory(async () => RESULT, { markersDir: path.join(dir, 'g1'), announce: path.join(dir, 'held') });
    const first = new AbortController();
    const held = reap(optionsFor(path.join(dir, 'g1'), first.signal));
    first.abort(new Error('shutdown'));
    await held;
    expect(await reap(optionsFor(path.join(dir, 'g1'), new AbortController().signal))).toBe(RESULT);
  });
});
