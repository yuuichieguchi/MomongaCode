import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimPathOf } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { sweepSessionTmp, sweepSpawnTmp } from '../../src/process/tmp-sweep.ts';
import { makeDir, makeTempHome, START_MS } from './helpers.ts';
import type { TempHome } from './helpers.ts';
import { testKernelLock, expectedKernelLockOn, writeLeftoverEntry } from '@momonga/testkit';

const DAY_MS = 86_400_000;
const NOW = START_MS + 30 * DAY_MS;

const sessionId = (n: number): string => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

type Activity = { lastActivityAt: number; hasActiveRun: boolean };

afterEach(() => {
  vi.restoreAllMocks();
});

const activityStore = (activities: Record<string, Activity | (() => Activity | undefined)>) => {
  const calls: string[] = [];
  return {
    calls,
    sessionActivity: (id: string): Activity | undefined => {
      calls.push(id);
      const entry = activities[id];
      return typeof entry === 'function' ? entry() : entry;
    },
  };
};

const idle = (ageMs: number): Activity => ({ lastActivityAt: NOW - ageMs, hasActiveRun: false });

const warnings = () => {
  const messages: string[] = [];
  return { messages, onWarning: (message: string) => void messages.push(message) };
};

const abandonedDirectory = (parent: string, name: string): string => {
  const directory = path.join(parent, name);
  const lock = testKernelLock();
  const claimed = lock.claimSync?.(claimPathOf(lock, directory, 'sidecar'));
  if (claimed?.kind !== 'claimed') throw new Error(`the sidecar of ${directory} could not be claimed by the test`);
  fs.mkdirSync(directory);
  claimed.lock.release();
  return directory;
};

const sessionDir = (temp: TempHome, id: string, file = 'note.txt'): string => {
  const dir = abandonedDirectory(temp.paths.tmp.sessions, id);
  fs.writeFileSync(path.join(dir, file), 'x');
  return dir;
};

const exists = (target: string): boolean => {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

const sweep = (temp: TempHome, store: { sessionActivity(id: string): Activity | undefined }, lock: KernelLockMechanism = testKernelLock()) => {
  const warned = warnings();
  return { warned, result: sweepSessionTmp({ root: temp.paths.tmp.sessions, store, now: NOW, onWarning: warned.onWarning, lock }) };
};

const holdScratchClaim = (entry: string): (() => void) => {
  const lock = testKernelLock();
  const claimed = lock.claimSync?.(claimPathOf(lock, entry, 'sidecar'));
  if (claimed?.kind !== 'claimed') throw new Error(`the sidecar of ${entry} could not be claimed by the test`);
  return () => claimed.lock.dispose();
};

describe('sweepSpawnTmp (fake clock, fake timers, none armed)', () => {
  it('removes spawn dirs whose sidecar lock no one holds, at start', async () => {
    const temp = await makeTempHome();
    const spawnRoot = temp.paths.tmp.spawn;
    fs.writeFileSync(path.join(makeDir(abandonedDirectory(spawnRoot, 'rg-1'), 'nested'), 'f'), 'x');
    abandonedDirectory(spawnRoot, 'rg-2');
    writeLeftoverEntry(testKernelLock(), path.join(spawnRoot, 'stray-file'), 'x');
    const warned = warnings();

    await sweepSpawnTmp({ lock: testKernelLock(), dir: spawnRoot, onWarning: warned.onWarning });

    expect(fs.readdirSync(spawnRoot)).toEqual([]);
    expect(warned.messages).toEqual([]);
  });

  it('keeps a symlink in spawn, which cannot carry a lock, without following it', async () => {
    const temp = await makeTempHome();
    const outside = makeDir(temp.root, 'outside');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'kept');
    fs.symlinkSync(outside, path.join(temp.paths.tmp.spawn, 'link'));

    await sweepSpawnTmp({ lock: testKernelLock(), dir: temp.paths.tmp.spawn, onWarning: warnings().onWarning });

    expect(fs.readdirSync(temp.paths.tmp.spawn)).toEqual(['link']);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('kept');
  });
});

describe('sweepSessionTmp (fake clock, fake timers, none armed)', () => {
  it('a missing sessions root removes and keeps nothing', async () => {
    const temp = await makeTempHome();
    fs.rmSync(temp.paths.tmp.sessions, { recursive: true });

    const { result } = sweep(temp, activityStore({}));

    expect(await result).toEqual({ removed: 0, kept: 0 });
  });

  it('removes the dir of an unknown session', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1));

    const { result, warned } = sweep(temp, activityStore({}));

    expect(await result).toEqual({ removed: 1, kept: 0 });
    expect(exists(dir)).toBe(false);
    expect(fs.readdirSync(temp.paths.tmp.sessions)).toEqual([]);
    expect(warned.messages).toEqual([]);
  });

  it('removes a session dir idle for exactly 7 days', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1));

    const { result } = sweep(temp, activityStore({ [sessionId(1)]: idle(7 * DAY_MS) }));

    expect(await result).toEqual({ removed: 1, kept: 0 });
    expect(exists(dir)).toBe(false);
  });

  it('keeps one with a non-terminal run', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1));

    const { result } = sweep(temp, activityStore({ [sessionId(1)]: { lastActivityAt: NOW - 30 * DAY_MS, hasActiveRun: true } }));

    expect(await result).toEqual({ removed: 0, kept: 1 });
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('x');
  });

  it('keeps a recent one (idle one millisecond less than 7 days)', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1));

    const { result } = sweep(temp, activityStore({ [sessionId(1)]: idle(7 * DAY_MS - 1) }));

    expect(await result).toEqual({ removed: 0, kept: 1 });
    expect(exists(dir)).toBe(true);
  });

  it('keeps a session whose scratch claim its owner holds', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1));
    const store = activityStore({});
    const release = holdScratchClaim(dir);

    try {
      const { result } = sweep(temp, store);

      expect(await result).toEqual({ removed: 0, kept: 1 });
      expect(exists(dir)).toBe(true);
    } finally {
      release();
    }
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} mechanism: unlinks file entries of removable names, made in the form the product writes them`, async () => {
      const lock = expectedKernelLockOn(platform);
      const temp = await makeTempHome();
      const file = path.join(temp.paths.tmp.sessions, sessionId(1));
      const claimed = await lock.claim(file);
      if (claimed.kind !== 'claimed') throw new Error(`${file} could not be claimed by the test`);
      fs.writeFileSync(file, 'stray');
      claimed.lock.release();

      const { result } = sweep(temp, activityStore({}), lock);

      expect(await result).toEqual({ removed: 1, kept: 0 });
      expect(fs.readdirSync(temp.paths.tmp.sessions)).toEqual([]);
    });
  }

  it('a symlink entry of a live session is kept untouched (its scratch claim is held)', async () => {
    const temp = await makeTempHome();
    const outside = makeDir(temp.root, 'outside');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'kept');
    const link = path.join(temp.paths.tmp.sessions, sessionId(1));
    fs.symlinkSync(outside, link);
    const release = holdScratchClaim(link);

    let swept: { removed: number; kept: number };
    try {
      swept = await sweep(temp, activityStore({})).result;
    } finally {
      release();
    }

    expect(swept).toEqual({ removed: 0, kept: 1 });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(outside);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('kept');
  });

  it('a symlink entry of a live session is kept untouched (an active run)', async () => {
    const temp = await makeTempHome();
    const outside = makeDir(temp.root, 'outside');
    const link = path.join(temp.paths.tmp.sessions, sessionId(1));
    fs.symlinkSync(outside, link);

    const { result } = sweep(temp, activityStore({ [sessionId(1)]: { lastActivityAt: NOW - 30 * DAY_MS, hasActiveRun: true } }));

    expect(await result).toEqual({ removed: 0, kept: 1 });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('a file entry of an unknown session is unlinked, and a symlink, which cannot carry a lock, is kept without being followed', async () => {
    const temp = await makeTempHome();
    const outside = makeDir(temp.root, 'outside');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'kept');
    const outsideFile = path.join(temp.root, 'outside-file');
    fs.writeFileSync(outsideFile, 'kept too');
    fs.symlinkSync(outside, path.join(temp.paths.tmp.sessions, sessionId(1)));
    fs.symlinkSync(outsideFile, path.join(temp.paths.tmp.sessions, sessionId(2)));
    writeLeftoverEntry(testKernelLock(), path.join(temp.paths.tmp.sessions, sessionId(3)), 'stray');

    const { result } = sweep(temp, activityStore({}));

    expect(await result).toEqual({ removed: 1, kept: 2 });
    expect(fs.readdirSync(temp.paths.tmp.sessions).sort()).toEqual([sessionId(1), sessionId(2)]);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('kept');
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('kept too');
  });

  it('an unremovable entry is a warning and the sweep continues with the other entries', async () => {
    const temp = await makeTempHome();
    const stuck = sessionDir(temp, sessionId(1));
    const locked = makeDir(stuck, 'locked');
    fs.writeFileSync(path.join(locked, 'pinned'), 'x');
    fs.chmodSync(locked, 0o500);
    const other = sessionDir(temp, sessionId(2));

    const { result, warned } = sweep(temp, activityStore({}));
    await result;

    expect(warned.messages.length).toBeGreaterThanOrEqual(1);
    expect(exists(other)).toBe(false);
  });

  it('a store error from sessionActivity propagates', async () => {
    const temp = await makeTempHome();
    sessionDir(temp, sessionId(1));
    const failure = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });

    const { result } = sweep(
      temp,
      activityStore({
        [sessionId(1)]: () => {
          throw failure;
        },
      }),
    );

    await expect(result).rejects.toBe(failure);
  });

  it('a store error while the claim is held releases the claim and propagates, and the dir is kept', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1));
    const failure = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });

    const { result, warned } = sweep(
      temp,
      activityStore({
        [sessionId(1)]: () => {
          throw failure;
        },
      }),
    );

    await expect(result).rejects.toBe(failure);
    expect(warned.messages).toEqual([]);
    expect(exists(dir)).toBe(true);
    expect(await testKernelLock().isHeld(claimPathOf(testKernelLock(), dir, 'sidecar'))).toBe(false);
  });

  it('retention is decided once, under the claim: the store is asked once per entry', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1));
    let lookups = 0;

    const { result } = sweep(
      temp,
      activityStore({
        [sessionId(1)]: () => {
          lookups += 1;
          return { lastActivityAt: NOW, hasActiveRun: true };
        },
      }),
    );

    expect(await result).toEqual({ removed: 0, kept: 1 });
    expect(lookups).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('x');
  });

  it('a removable dir is removed in place under its claim, with no rename', async () => {
    const temp = await makeTempHome();
    const dir = sessionDir(temp, sessionId(1), 'old.txt');
    const renameSpy = vi.spyOn(fs, 'renameSync');

    const { result } = sweep(temp, activityStore({}));

    expect(await result).toEqual({ removed: 1, kept: 0 });
    expect(renameSpy).not.toHaveBeenCalled();
    expect(exists(dir)).toBe(false);
    expect(fs.readdirSync(temp.paths.tmp.sessions)).toEqual([]);
  });

  it('a .removing-* dir left by a build before L1 has no sidecar, so no proof can be made, and it is kept (S5)', async () => {
    const temp = await makeTempHome();
    const leftover = path.join(temp.paths.tmp.sessions, '.removing-01900000-0000-7000-8000-000000000009');
    fs.writeFileSync(path.join(makeDir(leftover, 'deep'), 'f'), 'x');
    const store = activityStore({});

    const { result } = sweep(temp, store);

    expect(await result).toEqual({ removed: 0, kept: 1 });
    expect(exists(leftover)).toBe(true);
  });

  it('removability is decided before lstat (a spy asserts no lstat for a kept entry)', async () => {
    const temp = await makeTempHome();
    const live = sessionDir(temp, sessionId(1));
    const active = sessionDir(temp, sessionId(2));
    const lstatted: string[] = [];
    const originalLstatSync = fs.lstatSync;
    const originalLstat = fs.promises.lstat;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      lstatted.push(String(target));
      return (originalLstatSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.lstatSync);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      lstatted.push(String(target));
      return (originalLstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.promises.lstat);

    const release = holdScratchClaim(live);
    let swept: { removed: number; kept: number };
    try {
      swept = await sweep(temp, activityStore({ [sessionId(2)]: { lastActivityAt: NOW - 30 * DAY_MS, hasActiveRun: true } })).result;
    } finally {
      release();
    }

    expect(swept).toEqual({ removed: 0, kept: 2 });
    expect(lstatted).not.toContain(live);
    expect(lstatted).not.toContain(active);
  });
});
