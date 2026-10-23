import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalPath, comparableContains, comparablePath, setCaseSensitivityProbe, volumeIsCaseInsensitive } from '@momonga/foundation';

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
    expect(comparableContains(proj, path.join(proj, 'flink'))).toBe(false);
  });

  it('a dangling symlink pointing outside is not contained', () => {
    const { proj } = fixture();
    expect(comparableContains(proj, path.join(proj, 'dangle'))).toBe(false);
  });

  it('comparablePath of a file symlink is the comparable form of its target', () => {
    const { proj, out } = fixture();
    expect(canonicalPath(path.join(proj, 'flink'))).toBe(path.join(out, 'f'));
    expect(comparablePath(path.join(proj, 'flink'))).toBe(comparablePath(path.join(out, 'f')));
  });

  it('comparablePath of a dangling symlink is the comparable form of its target', () => {
    const { proj, out } = fixture();
    expect(comparablePath(path.join(proj, 'dangle'))).toBe(comparablePath(path.join(out, 'missing')));
  });

  it('comparablePath agrees with canonicalPath for existing files', () => {
    const { proj, out } = fixture();
    for (const file of [path.join(proj, 'File.txt'), path.join(out, 'f'), path.join(proj, 'flink')]) {
      expect(comparablePath(file)).toBe(comparablePath(canonicalPath(file)));
    }
  });
});

describe('.. handling', () => {
  it('resolves .. after a directory symlink the way the kernel does', () => {
    const { proj, other } = fixture();
    const input = path.join(proj, 'dlink') + '/../newfile';
    expect(() => comparablePath(input)).not.toThrow();
    expect(comparablePath(input)).toBe(comparablePath(path.join(other, 'newfile')));
    expect(comparableContains(proj, input)).toBe(false);
  });

  it('throws for .. below a missing component', () => {
    const { proj } = fixture();
    expect(() => comparablePath(path.join(proj, 'missing') + '/..')).toThrow();
  });
});

describe('canonicalPath errors', () => {
  it('propagates a symlink loop', () => {
    const { root } = fixture();
    fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
    fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
    expect(() => comparablePath(path.join(root, 'loop-a'))).toThrow();
  });

  it('propagates a path below a file', () => {
    const { proj } = fixture();
    expect(() => comparablePath(path.join(proj, 'File.txt', 'child'))).toThrow();
  });

  it.skipIf(RUNNING_AS_ROOT)('falls back to the deepest accessible directory plus the lexical tail on EACCES', () => {
    const { root } = fixture();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    lockedDirs.push(locked);
    const target = path.join(locked, 'x', 'y');
    expect(() => comparablePath(target)).not.toThrow();
    expect(comparableContains(root, target)).toBe(true);
    expect(comparableContains(path.join(root, 'proj'), target)).toBe(false);
  });
});

describe('volume verdict cache cost', () => {
  it('a warm lookup stats the cached mount root at most once beyond the deepest-existing walk', () => {
    const dir = makeDir();
    setCaseSensitivityProbe(() => true);
    volumeIsCaseInsensitive(dir);
    const spy = vi.spyOn(fs, 'statSync');
    expect(volumeIsCaseInsensitive(path.join(dir, 'Missing'))).toBe(true);
    const deepestExistingWalk = 2;
    expect(spy.mock.calls.length).toBeLessThanOrEqual(deepestExistingWalk + 1);
  });
});
