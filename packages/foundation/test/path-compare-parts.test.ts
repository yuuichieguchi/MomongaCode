import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCaseSensitivityProbe } from '@momonga/foundation';
import { syncPaths } from '../src/index.ts';

const tempDirs: string[] = [];
const lockedDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  setCaseSensitivityProbe(undefined);
  for (const dir of lockedDirs.splice(0)) fs.chmodSync(dir, 0o700);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-parts-')));
  tempDirs.push(dir);
  return dir;
};

const RUNNING_AS_ROOT = process.getuid?.() === 0;

const fixture = () => {
  const root = makeDir();
  const proj = path.join(root, 'proj');
  const out = path.join(root, 'out');
  const other = path.join(root, 'other');
  fs.mkdirSync(proj);
  fs.mkdirSync(out);
  fs.mkdirSync(path.join(other, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(out, 'f'), '');
  fs.writeFileSync(path.join(proj, 'File.txt'), '');
  fs.symlinkSync(path.join(out, 'f'), path.join(proj, 'flink'));
  fs.symlinkSync(path.join(out, 'missing'), path.join(proj, 'dangle'));
  fs.symlinkSync(path.join(other, 'inner'), path.join(proj, 'dlink'), 'dir');
  return { root, proj, out, other };
};

describe('a symlink as the last component', () => {
  it('a file symlink pointing outside is not contained', () => {
    const { proj } = fixture();
    expect(syncPaths.comparableContains(proj, path.join(proj, 'flink'))).toBe(false);
  });

  it('a dangling symlink pointing outside is not contained', () => {
    const { proj } = fixture();
    expect(syncPaths.comparableContains(proj, path.join(proj, 'dangle'))).toBe(false);
  });

  it('comparablePath of a file symlink is the comparable form of its target', () => {
    const { proj, out } = fixture();
    expect(syncPaths.canonicalPath(path.join(proj, 'flink'))).toBe(path.join(out, 'f'));
    expect(syncPaths.comparablePath(path.join(proj, 'flink'))).toBe(syncPaths.comparablePath(path.join(out, 'f')));
  });

  it('comparablePath of a dangling symlink is the comparable form of its target', () => {
    const { proj, out } = fixture();
    expect(syncPaths.comparablePath(path.join(proj, 'dangle'))).toBe(syncPaths.comparablePath(path.join(out, 'missing')));
  });

  it('comparablePath agrees with canonicalPath for existing files', () => {
    const { proj, out } = fixture();
    for (const file of [path.join(proj, 'File.txt'), path.join(out, 'f'), path.join(proj, 'flink')]) {
      expect(syncPaths.comparablePath(file)).toBe(syncPaths.comparablePath(syncPaths.canonicalPath(file)));
    }
  });
});

describe('.. handling', () => {
  it('resolves .. after a directory symlink the way the kernel does', async () => {
    const { proj, other } = fixture();
    const input = path.join(proj, 'dlink') + '/../newfile';
    await expect((async () => { await syncPaths.comparablePath(input); })()).resolves.toBeUndefined();
    expect(syncPaths.comparablePath(input)).toBe(syncPaths.comparablePath(path.join(other, 'newfile')));
    expect(syncPaths.comparableContains(proj, input)).toBe(false);
  });

  it('throws for .. below a missing component', async () => {
    const { proj } = fixture();
    await expect((async () => syncPaths.comparablePath(path.join(proj, 'missing') + '/..'))()).rejects.toThrow();
  });
});

describe('canonicalPath errors', () => {
  it('propagates a symlink loop', async () => {
    const { root } = fixture();
    fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
    fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
    await expect((async () => syncPaths.comparablePath(path.join(root, 'loop-a')))()).rejects.toThrow();
  });

  it('propagates a path below a file', async () => {
    const { proj } = fixture();
    await expect((async () => syncPaths.comparablePath(path.join(proj, 'File.txt', 'child')))()).rejects.toThrow();
  });

  it.skipIf(RUNNING_AS_ROOT)('falls back to the deepest accessible directory plus the lexical tail on EACCES', async () => {
    const { root } = fixture();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    lockedDirs.push(locked);
    const target = path.join(locked, 'x', 'y');
    await expect((async () => { await syncPaths.comparablePath(target); })()).resolves.toBeUndefined();
    expect(syncPaths.comparableContains(root, target)).toBe(true);
    expect(syncPaths.comparableContains(path.join(root, 'proj'), target)).toBe(false);
  });
});

describe('volume verdict cache cost', () => {
  it('a warm lookup stats the cached mount root at most once beyond the deepest-existing walk', () => {
    const dir = makeDir();
    setCaseSensitivityProbe(() => true);
    syncPaths.volumeIsCaseInsensitive(dir);
    const spy = vi.spyOn(fs, 'statSync');
    expect(syncPaths.volumeIsCaseInsensitive(path.join(dir, 'Missing'))).toBe(true);
    const deepestExistingWalk = 2;
    expect(spy.mock.calls.length).toBeLessThanOrEqual(deepestExistingWalk + 1);
  });
});
