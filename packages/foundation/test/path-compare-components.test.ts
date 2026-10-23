import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { comparableFromParts, comparablePath, containsByComponents } from '@momonga/foundation';

const tempDirs: string[] = [];
const lockedDirs: string[] = [];

afterEach(() => {
  for (const dir of lockedDirs.splice(0)) fs.chmodSync(dir, 0o700);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-parts-')));
  tempDirs.push(dir);
  return dir;
};


describe('containsByComponents', () => {
  it('does not contain an existing directory that differs only in case, even with foldTail', () => {
    expect(containsByComponents({ existing: '/S/Foo', tail: [] }, { existing: '/S/foo/mnt', tail: ['x'] }, true)).toBe(false);
    expect(containsByComponents({ existing: '/S/Foo', tail: [] }, { existing: '/S/foo', tail: [] }, true)).toBe(false);
  });

  it('contains an exact existing prefix', () => {
    expect(containsByComponents({ existing: '/S/Foo', tail: [] }, { existing: '/S/Foo/mnt', tail: ['x'] }, true)).toBe(true);
    expect(containsByComponents({ existing: '/S/Foo', tail: [] }, { existing: '/S/Foo', tail: [] }, false)).toBe(true);
  });

  it('contains a missing tail that differs only in case when foldTail is true', () => {
    expect(containsByComponents({ existing: '/S', tail: ['Missing'] }, { existing: '/S', tail: ['missing', 'child'] }, true)).toBe(true);
  });

  it('does not contain the same missing tail when foldTail is false', () => {
    expect(containsByComponents({ existing: '/S', tail: ['Missing'] }, { existing: '/S', tail: ['missing', 'child'] }, false)).toBe(false);
  });

  it('rejects a sibling that only shares a prefix', () => {
    expect(containsByComponents({ existing: '/S', tail: ['Missing'] }, { existing: '/S', tail: ['missing-x'] }, true)).toBe(false);
  });

  it('contains everything under the root', () => {
    expect(containsByComponents({ existing: '/', tail: [] }, { existing: '/S', tail: ['a'] }, false)).toBe(true);
  });
});

describe('comparableFromParts', () => {
  it('keeps existing components distinct even with foldTail', () => {
    expect(comparableFromParts({ existing: '/S/Foo', tail: [] }, true)).not.toBe(comparableFromParts({ existing: '/S/foo', tail: [] }, true));
  });

  it('makes case-variant tails equal with foldTail', () => {
    expect(comparableFromParts({ existing: '/S', tail: ['Missing', 'A'] }, true)).toBe(comparableFromParts({ existing: '/S', tail: ['missing', 'a'] }, true));
  });

  it('keeps case-variant tails distinct without foldTail', () => {
    expect(comparableFromParts({ existing: '/S', tail: ['Missing'] }, false)).not.toBe(comparableFromParts({ existing: '/S', tail: ['missing'] }, false));
  });
});

describe.skipIf(process.getuid?.() === 0)('comparablePath under an unreadable directory', () => {
  it('does not throw', () => {
    const root = makeDir();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    lockedDirs.push(locked);
    expect(() => comparablePath(path.join(locked, 'x', 'y'))).not.toThrow();
  });
});

describe('comparablePath', () => {
  it('rejects a relative path', () => {
    expect(() => comparablePath('relative/dir')).toThrow();
  });

  it('resolves a symlinked existing prefix', () => {
    const root = makeDir();
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    expect(comparablePath(path.join(root, 'link', 'x'))).toBe(comparablePath(path.join(root, 'real', 'x')));
  });
});
