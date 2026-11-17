import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFileSystem, nodeFileSystemSync } from '../src/node-file-system.ts';
import { createTempDir } from '@momonga/testkit';

let root: string;

beforeEach(() => {
  root = createTempDir();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nodeFileSystem', () => {
  it.runIf(process.platform === 'darwin')('resolves a path whose letter case differs to the case the disk stores, asynchronously as synchronously', async () => {
    const stored = fs.realpathSync.native(root);
    const flipped = stored.replace(/[a-z]/, (letter) => letter.toUpperCase());
    expect(flipped).not.toBe(stored);
    expect(await nodeFileSystem.realpath(flipped)).toBe(stored);
    expect(nodeFileSystemSync.realpathSync(flipped)).toBe(stored);
  });

  it('creates nested directories, writes and reads bytes and text, and stats them', async () => {
    const file = path.join(root, 'a', 'b', 'file.txt');
    await nodeFileSystem.mkdir(path.dirname(file));
    await nodeFileSystem.mkdir(path.dirname(file));
    await nodeFileSystem.writeFile(file, 'hello');
    expect(await nodeFileSystem.readFile(file)).toEqual(new Uint8Array(Buffer.from('hello')));
    expect(await nodeFileSystem.readTextFile(file)).toBe('hello');
    expect((await nodeFileSystem.stat(file)).isFile()).toBe(true);
    expect((await nodeFileSystem.stat(path.join(root, 'a'))).isDirectory()).toBe(true);
  });

  it('mkdir with a mode creates the directory with that mode and leaves the mode of an existing directory as it was', async () => {
    const created = path.join(root, 'made', 'nested');
    await nodeFileSystem.mkdir(created, 0o700);
    expect(fs.statSync(created).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(created)).mode & 0o777).toBe(0o700);

    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing);
    fs.chmodSync(existing, 0o755);
    await nodeFileSystem.mkdir(existing, 0o700);
    expect(fs.statSync(existing).mode & 0o777).toBe(0o755);
  });

  it('lists names and typed entries of a directory', async () => {
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'file'), '');
    expect((await nodeFileSystem.readdir(root)).sort()).toEqual(['dir', 'file']);
    const entries = (await nodeFileSystem.readdirEntries(root)).map((entry) => [entry.name, entry.isDirectory()] as const).sort();
    expect(entries).toEqual([
      ['dir', true],
      ['file', false],
    ]);
  });

  it('access resolves for a present file and rejects with ENOENT for a missing one', async () => {
    fs.writeFileSync(path.join(root, 'present'), '');
    await expect(nodeFileSystem.access(path.join(root, 'present'))).resolves.toBeUndefined();
    await expect(nodeFileSystem.access(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies a tree recursively and overwrites existing files', async () => {
    fs.mkdirSync(path.join(root, 'from', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'from', 'sub', 'x'), 'new');
    fs.mkdirSync(path.join(root, 'to', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'to', 'sub', 'x'), 'old');
    await nodeFileSystem.cp(path.join(root, 'from'), path.join(root, 'to'));
    expect(fs.readFileSync(path.join(root, 'to', 'sub', 'x'), 'utf8')).toBe('new');
  });

  it('makes a unique temporary directory under a prefix and removes a tree recursively', async () => {
    const made = await nodeFileSystem.mkdtemp(path.join(root, 'tmp-'));
    expect(path.basename(made).startsWith('tmp-')).toBe(true);
    fs.writeFileSync(path.join(made, 'inner'), '');
    await nodeFileSystem.rm(made, { recursive: true });
    expect(fs.existsSync(made)).toBe(false);
  });

  it('rm without the recursive option removes a file and refuses a non-empty directory', async () => {
    fs.writeFileSync(path.join(root, 'file'), '');
    await nodeFileSystem.rm(path.join(root, 'file'));
    expect(fs.existsSync(path.join(root, 'file'))).toBe(false);
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'dir', 'x'), '');
    await expect(nodeFileSystem.rm(path.join(root, 'dir'))).rejects.toBeDefined();
  });
});

describe('nodeFileSystemSync', () => {
  it('stats a path and checks existence and execute permission', () => {
    const file = path.join(root, 'tool');
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644);
    expect(nodeFileSystemSync.statSync(file).isFile()).toBe(true);
    expect(() => nodeFileSystemSync.accessSync(file, 'exists')).not.toThrow();
    if (process.platform !== 'win32') expect(() => nodeFileSystemSync.accessSync(file, 'execute')).toThrow(expect.objectContaining({ code: 'EACCES' }));
    fs.chmodSync(file, 0o755);
    expect(() => nodeFileSystemSync.accessSync(file, 'execute')).not.toThrow();
    expect(() => nodeFileSystemSync.accessSync(path.join(root, 'missing'), 'exists')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});
