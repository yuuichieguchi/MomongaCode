import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCaseSensitivityProbe } from '@momonga/foundation';
import { syncPaths } from '../src/index.ts';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  setCaseSensitivityProbe(undefined);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-remount-')));
  tempDirs.push(dir);
  return dir;
};

const mountRootOf = (target: string): string => {
  const device = fs.statSync(target).dev;
  let current = target;
  while (path.dirname(current) !== current && fs.statSync(path.dirname(current)).dev === device) current = path.dirname(current);
  return current;
};

describe('per-device case cache', () => {
  it('probes again when the mount root of a device changes inode', () => {
    const dir = makeDir();
    const mountRoot = mountRootOf(dir);
    const probed: string[] = [];
    setCaseSensitivityProbe((directory) => {
      probed.push(directory);
      return true;
    });
    let remounted = false;
    const realStatSync = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stats = realStatSync(target, options);
      if (!remounted || stats === undefined || path.resolve(String(target)) !== mountRoot) return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as fs.Stats, stats, {
        ino: typeof stats.ino === 'bigint' ? stats.ino + 1n : stats.ino + 1,
      });
    }) as typeof fs.statSync);

    expect(syncPaths.volumeIsCaseInsensitive(dir)).toBe(true);
    expect(syncPaths.volumeIsCaseInsensitive(path.join(dir, 'Missing'))).toBe(true);
    expect(probed).toHaveLength(1);

    remounted = true;
    expect(syncPaths.volumeIsCaseInsensitive(dir)).toBe(true);
    expect(probed).toHaveLength(2);
  });

  it('keeps the cached verdict while the mount root is unchanged', () => {
    const dir = makeDir();
    const probed: string[] = [];
    setCaseSensitivityProbe((directory) => {
      probed.push(directory);
      return true;
    });
    const spy = vi.spyOn(fs, 'statSync');
    syncPaths.volumeIsCaseInsensitive(dir);
    syncPaths.volumeIsCaseInsensitive(dir);
    expect(spy).toHaveBeenCalled();
    expect(probed).toHaveLength(1);
  });
});
