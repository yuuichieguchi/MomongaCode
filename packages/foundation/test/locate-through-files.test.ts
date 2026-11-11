import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { containsByComponents } from '@momonga/foundation';
import { syncPaths } from '../src/index.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const workspace = (): string => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-locate-')));
  directories.push(directory);
  return directory;
};

describe('locateThroughFiles', () => {
  it('gives a path below a regular file the form it has when nothing exists there', () => {
    const base = workspace();
    const target = path.join(base, '.git', 'hooks');
    const absent = syncPaths.locateThroughFiles(target);
    fs.writeFileSync(path.join(base, '.git'), '');
    const placeholder = syncPaths.locateThroughFiles(target);
    expect(placeholder.parts).toEqual(absent.parts);
    expect(placeholder.parts).toEqual({ existing: base, tail: ['.git', 'hooks'] });
  });

  it('gives a path below a directory the same components, so containment holds across a flip', () => {
    const base = workspace();
    const target = path.join(base, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.join(base, '.git', 'hooks'), { recursive: true });
    const guard = syncPaths.locateThroughFiles(path.join(base, '.git', 'hooks')).parts;
    fs.rmSync(path.join(base, '.git'), { recursive: true });
    fs.writeFileSync(path.join(base, '.git'), '');
    const located = syncPaths.locateThroughFiles(target);
    expect(containsByComponents(guard, located.parts, located.caseInsensitive)).toBe(true);
  });

  it('follows a symlink on the way, as canonicalPath does', () => {
    const base = workspace();
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync('real', path.join(base, 'link'));
    expect(syncPaths.locateThroughFiles(path.join(base, 'link', 'x')).parts).toEqual({ existing: path.join(base, 'real'), tail: ['x'] });
  });

  it('follows a symlink whose target passes through a file the same way with and without that file', () => {
    const base = workspace();
    fs.symlinkSync('g/hooks/x', path.join(base, 'l'));
    const absent = syncPaths.locateThroughFiles(path.join(base, 'l'));
    fs.writeFileSync(path.join(base, 'g'), '');
    const placeholder = syncPaths.locateThroughFiles(path.join(base, 'l'));
    expect(placeholder.parts).toEqual(absent.parts);
    expect(placeholder.parts).toEqual({ existing: base, tail: ['g', 'hooks', 'x'] });
  });

  it('climbs only over a regular file: a link component is followed, not dropped', () => {
    const base = workspace();
    fs.writeFileSync(path.join(base, 'g'), '');
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync('real', path.join(base, 'm'));
    fs.symlinkSync('../g/inner', path.join(base, 'real', 'n'));
    expect(syncPaths.locateThroughFiles(path.join(base, 'm', 'n', 'deep')).parts).toEqual({ existing: base, tail: ['g', 'inner', 'deep'] });
  });

  it('rethrows an error that is not ENOTDIR', async () => {
    const base = workspace();
    fs.symlinkSync('loop', path.join(base, 'loop'));
    await expect((async () => syncPaths.locateThroughFiles(path.join(base, 'loop', 'x')))()).rejects.toThrow(expect.objectContaining({ code: 'ELOOP' }));
  });

  it('control: comparablePath and canonicalPath still throw ENOTDIR below a regular file', async () => {
    const base = workspace();
    fs.writeFileSync(path.join(base, 'file'), '');
    await expect((async () => syncPaths.canonicalPath(path.join(base, 'file', 'x')))()).rejects.toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    await expect((async () => syncPaths.comparablePath(path.join(base, 'file', 'x')))()).rejects.toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });
});
