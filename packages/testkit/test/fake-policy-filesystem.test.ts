import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakePolicyFilesystem } from '@momonga/testkit';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fake-'));
  dirs.push(dir);
  return dir;
};

describe('fakePolicyFilesystem unreadable entries (V13)', () => {
  it('types a mode 000 file from readEntry', async () => {
    const file = path.join(makeDir(), '.git');
    fs.writeFileSync(file, 'x', { mode: 0o000 });
    expect(await fakePolicyFilesystem().readEntry(file)).toEqual({ unresolvable: { kind: 'errno', code: 'EACCES' } });
  });

  it('types a failing readlink from readNoFollow', async () => {
    const link = path.join(makeDir(), 'l');
    fs.symlinkSync('x', link);
    vi.spyOn(fs, 'readlinkSync').mockImplementation((() => {
      throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
    }) as typeof fs.readlinkSync);
    expect(await fakePolicyFilesystem().readNoFollow(link)).toEqual({ unresolvable: { kind: 'errno', code: 'EACCES' } });
  });
});

describe('fakePolicyFilesystem readNoFollow consults entries', () => {
  it('maps directory, file, oversize, absent and unresolved entries', async () => {
    const unresolvable = { unresolvable: { kind: 'errno', code: 'EACCES' } } as const;
    const fake = fakePolicyFilesystem({
      entries: {
        '/fake/dir': { kind: 'directory', canonical: '/fake/dir' },
        '/fake/file': { kind: 'file', text: 'x' },
        '/fake/big': { kind: 'oversize' },
        '/fake/absent': { kind: 'absent' },
        '/fake/unresolved': unresolvable,
      },
    });
    expect(await fake.readNoFollow('/fake/dir')).toEqual({ kind: 'directory' });
    expect(await fake.readNoFollow('/fake/file')).toEqual({ kind: 'other' });
    expect(await fake.readNoFollow('/fake/big')).toEqual({ kind: 'other' });
    expect(await fake.readNoFollow('/fake/absent')).toEqual({ kind: 'missing' });
    expect(await fake.readNoFollow('/fake/unresolved')).toEqual(unresolvable);
  });
});
