import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { containsByComponents, walkPath } from '@momonga/foundation';
import type { WalkEntry } from '@momonga/foundation';

const tree = (entries: Record<string, WalkEntry>) => (candidate: string): WalkEntry => entries[candidate.toLowerCase()] ?? { kind: 'missing' };

const links: string[] = [];
const onLink = (name: string): void => void links.push(name);

describe('walkPath with windows paths', () => {
  const step = tree({
    'c:\\work': { kind: 'directory' },
    'c:\\work\\src': { kind: 'directory' },
    'c:\\work\\link': { kind: 'symlink', target: 'src' },
    'c:\\work\\abs': { kind: 'symlink', target: 'D:\\data\\x' },
    'd:\\data': { kind: 'directory' },
    'd:\\data\\x': { kind: 'directory' },
    'c:\\work\\file.txt': { kind: 'other' },
  });

  it('walks drive-rooted paths with either separator', async () => {
    expect(await walkPath('C:\\work\\src\\a.ts', step, onLink, path.win32)).toEqual({ ok: true, prefix: 'C:\\work\\src', tail: ['a.ts'] });
    expect(await walkPath('C:/work/src', step, onLink, path.win32)).toEqual({ ok: true, prefix: 'C:\\work\\src', tail: [] });
  });

  it('follows a relative link and an absolute link onto another drive', async () => {
    expect(await walkPath('C:\\work\\link\\new.ts', step, onLink, path.win32)).toEqual({ ok: true, prefix: 'C:\\work\\src', tail: ['new.ts'] });
    expect(await walkPath('C:\\work\\abs\\y', step, onLink, path.win32)).toEqual({ ok: true, prefix: 'D:\\data\\x', tail: ['y'] });
  });

  it('resolves .. and reports a file used as a directory', async () => {
    expect(await walkPath('C:\\work\\src\\..\\src', step, onLink, path.win32)).toEqual({ ok: true, prefix: 'C:\\work\\src', tail: [] });
    expect(await walkPath('C:\\work\\file.txt\\x', step, onLink, path.win32)).toMatchObject({ ok: false, failure: { reason: { code: 'ENOTDIR' } } });
  });

  it('walks UNC roots', async () => {
    const unc = tree({ '\\\\server\\share\\a': { kind: 'directory' } });
    expect(await walkPath('\\\\server\\share\\a\\b', unc, onLink, path.win32)).toEqual({ ok: true, prefix: '\\\\server\\share\\a', tail: ['b'] });
  });

  it('rejects relative paths', async () => {
    await expect(walkPath('work\\src', step, onLink, path.win32)).rejects.toThrow('absolute');
  });
});

describe('containsByComponents with windows paths', () => {
  const parts = (existing: string, ...tail: string[]) => ({ existing, tail });

  it('compares the drive letter without case and the existing part exactly', () => {
    expect(containsByComponents(parts('c:\\Work'), parts('C:\\Work\\src', 'a.ts'), false, path.win32)).toBe(true);
    expect(containsByComponents(parts('C:\\Work'), parts('C:\\work\\src'), false, path.win32)).toBe(false);
  });

  it('folds the not-yet-existing tail on a case-insensitive volume', () => {
    expect(containsByComponents(parts('C:\\Work', 'New'), parts('C:\\Work', 'new', 'x'), true, path.win32)).toBe(true);
    expect(containsByComponents(parts('C:\\Work', 'New'), parts('C:\\Work', 'new', 'x'), false, path.win32)).toBe(false);
  });

  it('treats forward and back slashes alike', () => {
    expect(containsByComponents(parts('C:/Work'), parts('C:\\Work\\src'), false, path.win32)).toBe(true);
  });
});
