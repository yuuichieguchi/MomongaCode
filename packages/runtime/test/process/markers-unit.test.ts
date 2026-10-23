import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findHolders } from '@momonga/foundation';
import type { ReapMarkedProcessesOptions } from '@momonga/foundation';
import type { IdempotencyLookup, IdempotencyRecord } from '@momonga/store';
import { createFakeClock, createFakeTimers, fakeReapTiming, killGroupsForCleanup, waitFor } from '@momonga/testkit';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { START_MS, makeTempHome } from './helpers.ts';
import type { TempHome } from './helpers.ts';

const KILL_GRACE_MS = 2000;
const spawnedGroups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(spawnedGroups.splice(0));
});

const keyOf = (n: number): string => n.toString(16).padStart(64, '0');

const markerOf = (temp: TempHome, name: string): string => {
  const marker = path.join(temp.paths.markers.tools, name);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

const exists = (target: string): boolean => {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

const holdMarker = async (marker: string): Promise<number> => {
  const fd = fs.openSync(marker, 'r');
  let pid: number | undefined;
  try {
    const child = spawn('/bin/sh', ['-c', 'exec /bin/sleep 30'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } });
    child.unref();
    pid = child.pid;
    if (pid === undefined) throw new Error('the holder did not start');
    spawnedGroups.push(pid);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await findHolders(marker)).includes(pid)) return pid;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`process ${pid} never showed up as a holder of ${marker}`);
};

const record = (key: string, state: IdempotencyRecord['state'], pgid?: number): IdempotencyRecord => ({
  key,
  state,
  meta: {},
  ...(pgid === undefined ? {} : { pgid }),
  createdAt: START_MS,
  expiresAt: START_MS + 7 * 86_400_000,
});

const idempotencyOf = (lookups: Record<string, IdempotencyLookup | Error>) => {
  const asked: string[] = [];
  return {
    asked,
    store: {
      idempotency: {
        get: (key: string): IdempotencyLookup | undefined => {
          asked.push(key);
          const entry = lookups[key];
          if (entry instanceof Error) throw entry;
          return entry;
        },
      },
    } as never,
  };
};

const recordingReap = (behaviour: (options: ReapMarkedProcessesOptions) => Promise<{ removed: boolean }> = async () => ({ removed: true })) => {
  const calls: ReapMarkedProcessesOptions[] = [];
  return {
    calls,
    reap: (options: ReapMarkedProcessesOptions) => {
      calls.push(options);
      return behaviour(options);
    },
  };
};

const warnings = () => {
  const messages: string[] = [];
  return { messages, onWarning: (message: string) => void messages.push(message) };
};

describe('reapToolMarkers (real processes, system timers, except where fake timers are stated)', () => {
  it('a store error propagates and no reap is called (D2: every lookup happens before any reap)', async () => {
    const temp = await makeTempHome();
    const first = markerOf(temp, keyOf(1));
    const second = markerOf(temp, keyOf(2));
    await holdMarker(first);
    await holdMarker(second);
    const failure = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
    const { store } = idempotencyOf({ [keyOf(1)]: { s: 'COMPLETED', result: {} }, [keyOf(2)]: failure });
    const reaper = recordingReap();

    const outcome = reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    await expect(outcome).rejects.toBe(failure);
    expect(reaper.calls).toEqual([]);
  });

  it('allSettled turns a reap failure into a warning and the other markers are still reaped', async () => {
    const temp = await makeTempHome();
    const failing = markerOf(temp, keyOf(1));
    const fine = markerOf(temp, keyOf(2));
    await holdMarker(failing);
    await holdMarker(fine);
    const { store } = idempotencyOf({});
    const reaper = recordingReap(async (options) => {
      if (options.marker === failing) throw new Error('reap exploded');
      return { removed: true };
    });
    const warned = warnings();

    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, reap: reaper.reap as never });

    expect(reaper.calls.map((call) => call.marker).sort()).toEqual([failing, fine].sort());
    expect(warned.messages).toHaveLength(1);
    expect(warned.messages[0]).toContain('reap exploded');
  });

  it('tool markers are reaped concurrently (fake timers, fake ReapTiming, an injected reap records overlap)', async () => {
    const temp = await makeTempHome();
    const markers = [markerOf(temp, keyOf(1)), markerOf(temp, keyOf(2))];
    for (const marker of markers) await holdMarker(marker);
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const timing = fakeReapTiming(clock, timers);
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const reaper = recordingReap(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { removed: true };
    });

    const done = reapToolMarkers({ dir: temp.paths.markers.tools, store: idempotencyOf({}).store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, timing, reap: reaper.reap as never });
    await waitFor(() => releases.length === 2, { description: 'both reaps to be in flight' });
    expect(maxActive).toBe(2);
    for (const release of releases) release();
    await done;

    expect(reaper.calls.every((call) => call.timing === timing)).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('PENDING with a holder is kept and not reaped', async () => {
    const temp = await makeTempHome();
    const marker = markerOf(temp, keyOf(1));
    await holdMarker(marker);
    const { store } = idempotencyOf({ [keyOf(1)]: { s: 'PENDING', rec: record(keyOf(1), 'PENDING', 4321) } });
    const reaper = recordingReap();

    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(reaper.calls).toEqual([]);
    expect(exists(marker)).toBe(true);
  });

  it('COMPLETED and missing records with a holder are reaped by holders only, with label tool and the timing passed through', async () => {
    const temp = await makeTempHome();
    const completed = markerOf(temp, keyOf(1));
    const missing = markerOf(temp, keyOf(2));
    await holdMarker(completed);
    await holdMarker(missing);
    const clock = createFakeClock(START_MS);
    const timing = fakeReapTiming(clock, createFakeTimers(clock));
    const { store } = idempotencyOf({ [keyOf(1)]: { s: 'COMPLETED', result: { ok: true } } });
    const reaper = recordingReap();
    const warned = warnings();

    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, timing, reap: reaper.reap as never });

    const byMarker = new Map(reaper.calls.map((call) => [call.marker, call]));
    expect([...byMarker.keys()].sort()).toEqual([completed, missing].sort());
    for (const call of byMarker.values()) {
      expect(call).toMatchObject({ killGraceMs: KILL_GRACE_MS, label: 'tool', timing });
      expect(call.pgid).toBeUndefined();
    }
  });

  it('UNKNOWN with a holder is reaped with the recorded pgid, and an UNKNOWN record with no pgid is reaped by holders only', async () => {
    const temp = await makeTempHome();
    const withGroup = markerOf(temp, keyOf(1));
    const withoutGroup = markerOf(temp, keyOf(2));
    await holdMarker(withGroup);
    await holdMarker(withoutGroup);
    const { store } = idempotencyOf({
      [keyOf(1)]: { s: 'UNKNOWN', rec: record(keyOf(1), 'UNKNOWN', 98765) },
      [keyOf(2)]: { s: 'UNKNOWN', rec: record(keyOf(2), 'UNKNOWN') },
    });
    const reaper = recordingReap();

    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    const byMarker = new Map(reaper.calls.map((call) => [call.marker, call]));
    expect(byMarker.get(withGroup)?.pgid).toBe(98765);
    expect(byMarker.has(withoutGroup)).toBe(true);
    expect(byMarker.get(withoutGroup)?.pgid).toBeUndefined();
  });

  it('holder-less markers are deleted whatever the record, without a lookup or a reap', async () => {
    const temp = await makeTempHome();
    const pending = markerOf(temp, keyOf(1));
    const unknown = markerOf(temp, keyOf(2));
    const odd = markerOf(temp, 'not-a-key');
    const { store, asked } = idempotencyOf({
      [keyOf(1)]: { s: 'PENDING', rec: record(keyOf(1), 'PENDING', 4321) },
      [keyOf(2)]: { s: 'UNKNOWN', rec: record(keyOf(2), 'UNKNOWN', 4322) },
    });
    const reaper = recordingReap();

    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect([pending, unknown, odd].map(exists)).toEqual([false, false, false]);
    expect(asked).toEqual([]);
    expect(reaper.calls).toEqual([]);
  });

  it('a held marker whose name is not a 64-hex key is reaped as missing without a store lookup', async () => {
    const temp = await makeTempHome();
    const marker = markerOf(temp, 'NOT-A-KEY');
    await holdMarker(marker);
    const { store, asked } = idempotencyOf({});
    const reaper = recordingReap();

    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(asked).toEqual([]);
    expect(reaper.calls.map((call) => call.marker)).toEqual([marker]);
  });

  it('a holder on fake time is reaped by the real reaper through fakeReapTiming (fake timers)', async () => {
    const temp = await makeTempHome();
    const marker = markerOf(temp, keyOf(1));
    await holdMarker(marker);
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const timing = fakeReapTiming(clock, timers);
    const { store } = idempotencyOf({ [keyOf(1)]: { s: 'COMPLETED', result: {} } });

    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, timing });

    expect(exists(marker)).toBe(false);
    expect(await findHolders(marker)).toEqual([]);
    expect(timers.pending()).toEqual([]);
  });
});
