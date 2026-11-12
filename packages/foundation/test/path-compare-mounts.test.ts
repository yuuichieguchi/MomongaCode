import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCaseSensitivityProbe } from '@momonga/foundation';
import { syncPaths } from '../src/index.ts';
import { createTempDir } from '@momonga/testkit';

const tempDirs: string[] = [];
const lockedDirs: string[] = [];

afterEach(() => {
  setCaseSensitivityProbe(undefined);
  for (const dir of lockedDirs.splice(0)) fs.chmodSync(dir, 0o700);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = createTempDir();
  tempDirs.push(dir);
  return dir;
};

const deviceOf = (target: string): number | undefined => {
  try {
    return fs.statSync(target).dev;
  } catch {
    return undefined;
  }
};

const VM = '/System/Volumes/VM';
const VM_IS_SEPARATE_MOUNT = deviceOf(VM) !== undefined && deviceOf(VM) !== deviceOf('/System/Volumes');
const RUNNING_AS_ROOT = process.getuid?.() === 0;

const vmSensitive = (directory: string): boolean => !(directory === VM || directory.startsWith(`${VM}/`));
const vmInsensitive = (directory: string): boolean => directory === VM || directory.startsWith(`${VM}/`);

describe.runIf(VM_IS_SEPARATE_MOUNT)('folding across a mount boundary', () => {
  it('contains a missing tail under a case-sensitive mount inside a case-insensitive base', () => {
    setCaseSensitivityProbe(vmSensitive);
    expect(syncPaths.comparableContains('/System/Volumes', `${VM}/Missing`)).toBe(true);
  });

  it('does not match a case-variant missing tail on the case-sensitive mount', () => {
    setCaseSensitivityProbe(vmSensitive);
    expect(syncPaths.comparableContains(`${VM}/Missing`, `${VM}/missing/child`)).toBe(false);
  });

  it('contains a missing tail under a case-insensitive mount inside a case-sensitive base', () => {
    setCaseSensitivityProbe(vmInsensitive);
    expect(syncPaths.comparableContains('/System/Volumes', `${VM}/Missing`)).toBe(true);
  });
});

describe('folding on one volume', () => {
  it('matches a case-variant missing tail on a case-insensitive volume', () => {
    setCaseSensitivityProbe(() => true);
    const root = makeDir();
    expect(syncPaths.comparableContains(path.join(root, 'Missing'), path.join(root, 'missing', 'child'))).toBe(true);
  });
});

describe.skipIf(RUNNING_AS_ROOT)('targets under an unreadable directory', () => {
  const lockedTarget = (): { root: string; target: string } => {
    const root = makeDir();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    lockedDirs.push(locked);
    return { root, target: path.join(locked, 'x', 'y') };
  };

  it('volumeIsCaseInsensitive decides from the deepest directory that can be stat-ed', () => {
    const { root, target } = lockedTarget();
    expect(syncPaths.volumeIsCaseInsensitive(target)).toBe(syncPaths.volumeIsCaseInsensitive(root));
  });

  it('comparableContains does not throw and still reports containment', () => {
    const { root, target } = lockedTarget();
    expect(syncPaths.comparableContains(root, target)).toBe(true);
  });

  it('a probe that cannot read a directory does not throw', async () => {
    const root = makeDir();
    const locked = path.join(root, '0000');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    lockedDirs.push(locked);
    await expect((async () => { await syncPaths.volumeIsCaseInsensitive(path.join(locked, 'x')); })()).resolves.toBeUndefined();
  });
});
