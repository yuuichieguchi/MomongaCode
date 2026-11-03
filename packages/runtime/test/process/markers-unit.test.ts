import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findHolders } from '@momonga/foundation';
import type { ReapMarkedProcessesOptions } from '@momonga/foundation';
import type { IdempotencyLookup, IdempotencyRecord, Run } from '@momonga/store';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, fakeReapTiming, killGroupsForCleanup, spawnTracked, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { START_MS, makeTempHome } from './helpers.ts';
import type { TempHome } from './helpers.ts';

const holderProbe = vi.hoisted(() => ({ findHolderCalls: 0 }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...original,
    findHolders: (...args: Parameters<typeof original.findHolders>) => {
      holderProbe.findHolderCalls += 1;
      return original.findHolders(...args);
    },
  };
});

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

describe('reapToolMarkers on hook markers', () => {
  it('reaps the holder of a hook marker that has no idempotency record', async () => {
    const temp = await makeTempHome();
    const marker = markerOf(temp, `hook-${keyOf(7)}`);
    const pid = await holdMarker(marker);
    const { store } = idempotencyOf({});
    await reapToolMarkers({ dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning });
    expect(await findHolders(marker)).not.toContain(pid);
    expect(exists(marker)).toBe(false);
  });
});

describe('reapToolMarkers (real processes, system timers, except where fake timers are stated)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
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

const deadLetterKey = (n: number): string => (0xd000 + n).toString(16).padStart(64, '0');

const trackedMarkerDir = (context: CleanupContext): string => {
  const dir = path.join(withTempDir(context), 'tools');
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const emptyMarker = (dir: string, name: string): string => {
  const marker = path.join(dir, name);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

const trackedHolder = async (context: CleanupContext, marker: string): Promise<number> => {
  const fd = fs.openSync(marker, 'r');
  let pid: number;
  try {
    pid = spawnTracked(context, '/bin/sh', ['-c', 'exec /bin/sleep 30'], { stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } }).pid;
  } finally {
    fs.closeSync(fd);
  }
  const deadline = Date.now() + 10_000;
  while (!(await findHolders(marker)).includes(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} never showed up as a holder of ${marker}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return pid;
};

type RunFixture = Pick<Run, 'id' | 'status' | 'deadLetter'>;

const pendingFor = (key: string, runId: string | undefined, pgid?: number): IdempotencyLookup => {
  const base = record(key, 'PENDING', pgid);
  return { s: 'PENDING', rec: { ...base, meta: runId === undefined ? {} : { tool: 'Bash', runId } } } as IdempotencyLookup;
};

const deadLetterStore = (lookups: Record<string, IdempotencyLookup>, runs: readonly RunFixture[]) => {
  const runsAsked: string[] = [];
  return {
    runsAsked,
    store: {
      idempotency: { get: (key: string): IdempotencyLookup | undefined => lookups[key] },
      getRun: (id: string): RunFixture | undefined => {
        runsAsked.push(id);
        return runs.find((run) => run.id === id);
      },
    } as never,
  };
};

const PERIODIC = (skipKeys: ReadonlySet<string> = new Set()) => ({ deadLetterOnly: true as const, skipKeys });

const terminalWarning = (marker: string, runId: string): string => `tool marker ${marker}: run ${runId} is terminal, so its holder was reaped`;

describe('reapToolMarkers dead-lettered runs, start scope (§8)', () => {
  it('PENDING with a dead-lettered run is reaped with the recorded pgid and a warning naming the run', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(1);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-dead', pgid) }, [{ id: 'run-dead', status: 'FAILED', deadLetter: true }]);
    const reaper = recordingReap();
    const warned = warnings();

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, reap: reaper.reap as never });

    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, pgid, killGraceMs: KILL_GRACE_MS, label: 'tool' });
    expect(warned.messages).toContain(terminalWarning(marker, 'run-dead'));
  });

  it('PENDING with a non-terminal run is kept', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(2);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store, runsAsked } = deadLetterStore({ [key]: pendingFor(key, 'run-live', pgid) }, [{ id: 'run-live', status: 'RUNNING', deadLetter: false }]);
    const reaper = recordingReap();

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(runsAsked).toEqual(['run-live']);
    expect(reaper.calls).toEqual([]);
    expect(exists(marker)).toBe(true);
  });

  it('PENDING with an unknown run is kept', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(3);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store, runsAsked } = deadLetterStore({ [key]: pendingFor(key, 'run-gone', pgid) }, []);
    const reaper = recordingReap();

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(runsAsked).toEqual(['run-gone']);
    expect(reaper.calls).toEqual([]);
    expect(exists(marker)).toBe(true);
  });

  it('a terminal run that was not dead-lettered (CANCELLED, deadLetter false) is reaped at start', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(4);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-cancelled', pgid) }, [{ id: 'run-cancelled', status: 'CANCELLED', deadLetter: false }]);
    const reaper = recordingReap();

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never, scope: 'all' });

    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, pgid });
  });
});

describe('reapToolMarkers dead-lettered runs, periodic scope (§8)', () => {
  it('a dead-lettered run is reaped from the record alone: no findHolders, the recorded pgid, a warning naming the run', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(5);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-dead', pgid) }, [{ id: 'run-dead', status: 'FAILED', deadLetter: true }]);
    const reaper = recordingReap();
    const warned = warnings();
    holderProbe.findHolderCalls = 0;

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, reap: reaper.reap as never, scope: PERIODIC() });

    expect(holderProbe.findHolderCalls).toBe(0);
    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, pgid, killGraceMs: KILL_GRACE_MS, label: 'tool' });
    expect(warned.messages).toContain(terminalWarning(marker, 'run-dead'));
  });

  it('CANCELLED with deadLetter false is kept in the periodic scope', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(6);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-cancelled', pgid) }, [{ id: 'run-cancelled', status: 'CANCELLED', deadLetter: false }]);
    const reaper = recordingReap();

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never, scope: PERIODIC() });

    expect(reaper.calls).toEqual([]);
    expect(exists(marker)).toBe(true);
  });

  it('a dead-lettered run whose key is in skipKeys (an in-flight call) is skipped', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(7);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-dead', pgid) }, [{ id: 'run-dead', status: 'FAILED', deadLetter: true }]);
    const reaper = recordingReap();

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never, scope: PERIODIC(new Set([key])) });

    expect(reaper.calls).toEqual([]);
    expect(exists(marker)).toBe(true);
  });

  it('PENDING without runId, an unknown run, and a non-key name are all left alone', async (context) => {
    const dir = trackedMarkerDir(context);
    const noRunId = deadLetterKey(8);
    const unknownRun = deadLetterKey(9);
    const markers = [emptyMarker(dir, noRunId), emptyMarker(dir, unknownRun), emptyMarker(dir, 'not-a-key')];
    for (const marker of markers) await trackedHolder(context, marker);
    const { store } = deadLetterStore({ [noRunId]: pendingFor(noRunId, undefined, 1), [unknownRun]: pendingFor(unknownRun, 'run-gone', 1) }, []);
    const reaper = recordingReap();
    holderProbe.findHolderCalls = 0;

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never, scope: PERIODIC() });

    expect(reaper.calls).toEqual([]);
    expect(holderProbe.findHolderCalls).toBe(0);
    for (const marker of markers) expect(exists(marker)).toBe(true);
  });

  it('the periodic scope never touches a holder-less marker; the start scope removes the record-less one', async (context) => {
    const dir = trackedMarkerDir(context);
    const inFlight = deadLetterKey(10);
    const recordless = deadLetterKey(11);
    const inFlightMarker = emptyMarker(dir, inFlight);
    const recordlessMarker = emptyMarker(dir, recordless);
    const { store } = deadLetterStore({ [inFlight]: pendingFor(inFlight, 'run-live') }, [{ id: 'run-live', status: 'RUNNING', deadLetter: false }]);
    const reaper = recordingReap();
    holderProbe.findHolderCalls = 0;

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never, scope: PERIODIC() });

    expect(exists(inFlightMarker)).toBe(true);
    expect(exists(recordlessMarker)).toBe(true);
    expect(reaper.calls).toEqual([]);
    expect(holderProbe.findHolderCalls).toBe(0);

    await reapToolMarkers({ dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(exists(recordlessMarker)).toBe(false);
    expect(reaper.calls).toEqual([]);
  });
});
