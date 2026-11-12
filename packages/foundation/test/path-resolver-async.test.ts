import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPathResolver, hostPaths, nodeFileSystem, setCaseSensitivityProbe } from '../src/index.ts';
import type { PathFileSystem } from '../src/path-compare.ts';
import { createTempDir, systemTempRoot } from '@momonga/testkit';

type FakeStats = { dev: number; ino: number; isDirectory: () => boolean; isSymbolicLink: () => boolean; isFile: () => boolean };

const missing = (target: string): NodeJS.ErrnoException => Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const statsOf = (ino: number, directory: boolean): FakeStats => ({ dev: 7, ino, isDirectory: () => directory, isSymbolicLink: () => false, isFile: () => !directory });

const digitTree = (names: readonly string[]): { files: PathFileSystem; reads: () => number; closes: () => number } => {
  const directories = new Map<string, number>([['/', 1], ['/1', 2], ['/1/2', 3]]);
  const entries = new Map<string, number>(names.map((name, index) => [`/1/2/${name}`, 100 + index]));
  let reads = 0;
  let closes = 0;
  const stat = async (target: string): Promise<FakeStats> => {
    const directory = directories.get(target);
    if (directory !== undefined) return statsOf(directory, true);
    const entry = entries.get(target);
    if (entry !== undefined) return statsOf(entry, false);
    throw missing(target);
  };
  const files = {
    stat,
    lstat: stat,
    readlink: async (target: string): Promise<string> => Promise.reject(missing(target)),
    realpath: async (target: string): Promise<string> => target,
    access: async (): Promise<void> => undefined,
    openDirectory: async () => {
      let next = 0;
      return {
        read: async (): Promise<string | null> => {
          reads += 1;
          const name = names[next];
          next += 1;
          return name ?? null;
        },
        close: async (): Promise<void> => {
          closes += 1;
        },
      };
    },
  } as unknown as PathFileSystem;
  return { files, reads: () => reads, closes: () => closes };
};

afterEach(() => setCaseSensitivityProbe(undefined));

describe('the case-folding probe streams the directory', () => {
  it('stops reading at the first lettered entry that yields a verdict', async () => {
    const names = ['alpha', ...Array.from({ length: 5000 }, (_unused, index) => `entry${index}`)];
    const tree = digitTree(names);
    setCaseSensitivityProbe(undefined);
    const result = await createPathResolver(tree.files, new AbortController().signal).caseSensitivityOf('/1/2');
    expect(result).toMatchObject({ kind: 'supported', value: false });
    expect(tree.reads()).toBe(1);
    expect(tree.closes()).toBe(1);
  });

  it('skips entries without a letter and reads on until one can be compared', async () => {
    const tree = digitTree(['1', '22', 'beta', 'gamma']);
    setCaseSensitivityProbe(undefined);
    const result = await createPathResolver(tree.files, new AbortController().signal).caseSensitivityOf('/1/2');
    expect(result).toMatchObject({ kind: 'supported', value: false });
    expect(tree.reads()).toBe(3);
  });
});

describe('a resolution that does not answer ends with the signal of the operation that asked', () => {
  const stalled = (): PathFileSystem => ({ ...nodeFileSystem, lstat: () => never(), stat: () => never(), realpath: () => never() });

  it('leaves the event loop free while the file system does not answer, and rejects with the reason of the signal', async () => {
    const controller = new AbortController();
    const paths = createPathResolver(stalled(), controller.signal);
    const pending = paths.canonicalPath('/some/where');
    const fired = await new Promise<string>((resolve) => setTimeout(() => resolve('timer fired'), 0));
    expect(fired).toBe('timer fired');
    const reason = new Error('the operation that asked was cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it.each(['canonicalDirectory', 'resolveCanonicalPath', 'locate', 'locateThroughFiles', 'comparablePath', 'volumeIsCaseInsensitive', 'caseSensitivityOf'] as const)(
    '%s rejects with the reason and returns no result',
    async (method) => {
      const controller = new AbortController();
      const paths = createPathResolver(stalled(), controller.signal);
      const pending = paths[method]('/some/where');
      const reason = new Error('cancelled');
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    },
  );

  it('comparableContains rejects with the reason and returns no result', async () => {
    const controller = new AbortController();
    const pending = createPathResolver(stalled(), controller.signal).comparableContains('/a', '/a/b');
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const reason = new Error('already cancelled');
    await expect(hostPaths(AbortSignal.abort(reason)).canonicalPath(systemTempRoot())).rejects.toBe(reason);
  });
});

describe('the host resolver answers as the synchronous one did', () => {
  it('resolves a symlink chain and keeps a missing tail', async () => {
    const root = createTempDir();
    try {
      fs.mkdirSync(path.join(root, 'real'));
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
      const paths = hostPaths(new AbortController().signal);
      expect(await paths.canonicalPath(path.join(root, 'link', 'missing', 'file.txt'))).toBe(path.join(root, 'real', 'missing', 'file.txt'));
      expect(await paths.comparableContains(path.join(root, 'link'), path.join(root, 'real', 'x'))).toBe(true);
      expect(await paths.canonicalDirectory(path.join(root, 'link'))).toEqual({ ok: true, path: path.join(root, 'real') });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
