import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findHolders, recordMarkerGroup } from '@momonga/foundation';
import type { ReapMarkedProcessesOptions } from '@momonga/foundation';
import type { IdempotencyLookup, IdempotencyRecord, Run } from '@momonga/store';
import { HOLD_UNTIL_SIGNALLED, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, fakeReapTiming, killGroupsForCleanup, pollUntil, spawnTracked, waitFor, withTempDir, testProcessInspector } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { createMarkerOwners } from '@momonga/tools';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { START_MS, makeTempHome } from './helpers.ts';
import type { TempHome } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

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
const LEDGER_PGID = 1_111_111;
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
    const child = spawn('/bin/sh', ['-c', `exec ${HOLD_UNTIL_SIGNALLED}`], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } });
    child.unref();
    pid = child.pid;
    if (pid === undefined) throw new Error('the holder did not start');
    spawnedGroups.push(pid);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await findHolders(marker, { inspector: testProcessInspector(), signal: new AbortController().signal })).includes(pid)) return pid;
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
        processGroupOf: (key: string): number | undefined => {
          const entry = lookups[key];
          if (entry instanceof Error) throw entry;
          return entry === undefined || entry.s === 'COMPLETED' ? undefined : entry.rec.pgid;
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
    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning });
    expect(await findHolders(marker, { inspector: testProcessInspector(), signal: new AbortController().signal })).not.toContain(pid);
    expect(exists(marker)).toBe(false);
  });
});

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

    const outcome = reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

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

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, reap: reaper.reap as never });

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

    const done = reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store: idempotencyOf({}).store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, timing, reap: reaper.reap as never });
    await waitFor(() => releases.length === 2, { description: 'both reaps to be in flight' });
    expect(maxActive).toBe(2);
    for (const release of releases) release();
    await done;

    expect(reaper.calls.every((call) => call.timing === timing)).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('PENDING with a holder is reaped with the pgid recorded in the marker file: ownership decides, not the ledger row', async () => {
    const temp = await makeTempHome();
    const marker = markerOf(temp, keyOf(1));
    await recordMarkerGroup(marker, 4321);
    await holdMarker(marker);
    const { store } = idempotencyOf({ [keyOf(1)]: { s: 'PENDING', rec: record(keyOf(1), 'PENDING', LEDGER_PGID) } });
    const reaper = recordingReap();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, pgid: 4321 });
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

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, timing, reap: reaper.reap as never });

    const byMarker = new Map(reaper.calls.map((call) => [call.marker, call]));
    expect([...byMarker.keys()].sort()).toEqual([completed, missing].sort());
    for (const call of byMarker.values()) {
      expect(call).toMatchObject({ killGraceMs: KILL_GRACE_MS, label: 'tool', timing });
      expect(call.pgid).toBeUndefined();
    }
  });

  it('UNKNOWN with a holder is reaped with the pgid recorded in the marker file, and a marker with no group line is reaped by holders only whatever the ledger holds', async () => {
    const temp = await makeTempHome();
    const withGroup = markerOf(temp, keyOf(1));
    const withoutGroup = markerOf(temp, keyOf(2));
    await recordMarkerGroup(withGroup, 98765);
    await holdMarker(withGroup);
    await holdMarker(withoutGroup);
    const { store } = idempotencyOf({
      [keyOf(1)]: { s: 'UNKNOWN', rec: record(keyOf(1), 'UNKNOWN', LEDGER_PGID) },
      [keyOf(2)]: { s: 'UNKNOWN', rec: record(keyOf(2), 'UNKNOWN', LEDGER_PGID) },
    });
    const reaper = recordingReap();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

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

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

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

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

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

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir: temp.paths.markers.tools, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, timing });

    expect(exists(marker)).toBe(false);
    expect(await findHolders(marker, { inspector: testProcessInspector(), signal: new AbortController().signal })).toEqual([]);
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
    pid = spawnTracked(context, '/bin/sh', ['-c', `exec ${HOLD_UNTIL_SIGNALLED}`], { stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } }).pid;
  } finally {
    fs.closeSync(fd);
  }
  await pollUntil(async () => (await findHolders(marker, { inspector: testProcessInspector(), signal: new AbortController().signal })).includes(pid), { description: `process ${pid} to show up as a holder of ${marker}`, boundMs: REAL_PROCESS_TEST_TIMEOUT_MS / 2 });
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
      idempotency: {
        get: (key: string): IdempotencyLookup | undefined => lookups[key],
        processGroupOf: (key: string): number | undefined => {
          const entry = lookups[key];
          return entry === undefined || entry.s === 'COMPLETED' ? undefined : entry.rec.pgid;
        },
      },
      getRun: (id: string): RunFixture | undefined => {
        runsAsked.push(id);
        return runs.find((run) => run.id === id);
      },
    } as never,
  };
};

const terminalWarning = (marker: string, runId: string): string => `tool marker ${marker}: run ${runId} is terminal, so its holder was reaped`;

describe('reapToolMarkers dead-lettered runs, start scope (§8)', () => {
  it('PENDING with a dead-lettered run is reaped with the pgid recorded in the marker file and a warning naming the run', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(1);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    await recordMarkerGroup(marker, pgid);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-dead', LEDGER_PGID) }, [{ id: 'run-dead', status: 'FAILED', deadLetter: true }]);
    const reaper = recordingReap();
    const warned = warnings();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, reap: reaper.reap as never });

    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, pgid, killGraceMs: KILL_GRACE_MS, label: 'tool' });
    expect(warned.messages).toContain(terminalWarning(marker, 'run-dead'));
  });

  it('PENDING with a non-terminal run is reaped without the terminal-run warning', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(2);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store, runsAsked } = deadLetterStore({ [key]: pendingFor(key, 'run-live', pgid) }, [{ id: 'run-live', status: 'RUNNING', deadLetter: false }]);
    const reaper = recordingReap();
    const warned = warnings();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, reap: reaper.reap as never });

    expect(runsAsked).toEqual(['run-live']);
    expect(reaper.calls).toHaveLength(1);
    expect(warned.messages).not.toContain(terminalWarning(marker, 'run-live'));
  });

  it('PENDING with an unknown run is reaped without the terminal-run warning', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(3);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store, runsAsked } = deadLetterStore({ [key]: pendingFor(key, 'run-gone', pgid) }, []);
    const reaper = recordingReap();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(runsAsked).toEqual(['run-gone']);
    expect(reaper.calls).toHaveLength(1);
  });

  it('a terminal run that was not dead-lettered (CANCELLED, deadLetter false) is reaped at start', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(4);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    await recordMarkerGroup(marker, pgid);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-cancelled', LEDGER_PGID) }, [{ id: 'run-cancelled', status: 'CANCELLED', deadLetter: false }]);
    const reaper = recordingReap();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'startup', owners: createMarkerOwners(), dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, pgid });
  });
});

describe('reapToolMarkers by event: the sweep reads the unowned markers only', () => {
  it('a dead-lettered run is reaped with the pgid recorded in the marker file and a warning naming the run', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(5);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    await recordMarkerGroup(marker, pgid);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-dead', LEDGER_PGID) }, [{ id: 'run-dead', status: 'FAILED', deadLetter: true }]);
    const reaper = recordingReap();
    const warned = warnings();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'sweep', owners: createMarkerOwners(), dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warned.onWarning, reap: reaper.reap as never });

    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, pgid, killGraceMs: KILL_GRACE_MS, label: 'tool' });
    expect(warned.messages).toContain(terminalWarning(marker, 'run-dead'));
  });

  it('a marker with a live owner is neither read nor reaped', async (context) => {
    const dir = trackedMarkerDir(context);
    const key = deadLetterKey(7);
    const marker = emptyMarker(dir, key);
    const pgid = await trackedHolder(context, marker);
    const { store } = deadLetterStore({ [key]: pendingFor(key, 'run-dead', pgid) }, [{ id: 'run-dead', status: 'FAILED', deadLetter: true }]);
    const owners = createMarkerOwners();
    owners.register(key, { alive: () => true });
    const reaper = recordingReap();
    holderProbe.findHolderCalls = 0;

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'sweep', owners, dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(reaper.calls).toEqual([]);
    expect(holderProbe.findHolderCalls).toBe(0);
    expect(exists(marker)).toBe(true);
  });

  it('a held marker is reaped whatever its row says, and a holder-less one is removed without a reap', async (context) => {
    const dir = trackedMarkerDir(context);
    const noRunId = deadLetterKey(8);
    const unknownRun = deadLetterKey(9);
    const held = [emptyMarker(dir, noRunId), emptyMarker(dir, unknownRun), emptyMarker(dir, 'not-a-key')];
    for (const marker of held) await trackedHolder(context, marker);
    const recordless = emptyMarker(dir, deadLetterKey(11));
    const { store } = deadLetterStore({ [noRunId]: pendingFor(noRunId, undefined, 1), [unknownRun]: pendingFor(unknownRun, 'run-gone', 1) }, []);
    const reaper = recordingReap();

    await reapToolMarkers({ inspector: testProcessInspector(), event: 'sweep', owners: createMarkerOwners(), dir, store, killGraceMs: KILL_GRACE_MS, onWarning: warnings().onWarning, reap: reaper.reap as never });

    expect(reaper.calls.map((call) => call.marker).sort()).toEqual([...held].sort());
    expect(exists(recordless)).toBe(false);
  });
});
