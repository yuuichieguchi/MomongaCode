import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, createUserSettingsCache, loadMcpServers, noKeptRecords } from '@momonga/config';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const NOT_ABORTED = new AbortController().signal;

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:00:10Z');

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

const writeAt = (file: string, value: unknown, at: Date): void => {
  writeJson(file, value);
  fs.utimesSync(file, at, at);
};

const rejectionOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );

type Fault = { error?: Error };

type FaultSite = 'lstat' | 'read';

const faultyFiles = (target: string, site: FaultSite, fault: Fault): FileSystem => {
  const failing = (at: FaultSite, file: string): void => {
    if (at === site && file === target && fault.error !== undefined) throw fault.error;
  };
  return {
    ...nodeFileSystem,
    lstat: async (file) => {
      failing('lstat', file);
      return nodeFileSystem.lstat(file);
    },
    readTextFile: async (file) => {
      failing('read', file);
      return nodeFileSystem.readTextFile(file);
    },
  };
};

const cacheWith = (home: string, files: FileSystem) => createUserSettingsCache({ home, onWarning: () => undefined, keptRecords: noKeptRecords, files });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserSettingsCache with a transient errno after a good load', () => {
  for (const site of ['lstat', 'read'] as const) {
    it(`loadOrKeep keeps the last good settings and load rejects with the same EMFILE when the ${site} fails`, async () => {
      const tree = makeTree();
      const file = userSettingsPath(tree);
      writeAt(file, { env: { TZ: 'good' } }, T0);
      const fault: Fault = {};
      const cache = cacheWith(tree.home, faultyFiles(file, site, fault));
      expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ TZ: 'good' });

      writeAt(file, { env: { TZ: 'newer' } }, T1);
      fault.error = errnoError('EMFILE');

      expect(await rejectionOf(cache.loadOrKeep(NOT_ABORTED))).toBeUndefined();
      expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ TZ: 'good' });
      expect(await rejectionOf(cache.load(NOT_ABORTED))).toBe(fault.error);
      expect(await rejectionOf(cache.load(NOT_ABORTED))).toBe(fault.error);

      delete fault.error;
      const snapshot = await cache.load(NOT_ABORTED);
      expect('error' in snapshot).toBe(false);
      expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ TZ: 'newer' });
    });
  }

  it('loadOrKeep rejects with the transient error when there was no prior good load', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const fault: Fault = { error: errnoError('EMFILE') };
    const cache = cacheWith(tree.home, faultyFiles(file, 'read', fault));
    expect(await rejectionOf(cache.loadOrKeep(NOT_ABORTED))).toBe(fault.error);
    delete fault.error;
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ TZ: 'good' });
  });

  it('a non-transient errno (EACCES) still becomes a ConfigError snapshot', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, {}, T0);
    const cache = cacheWith(tree.home, faultyFiles(file, 'read', { error: errnoError('EACCES') }));
    const snapshot = await cache.load(NOT_ABORTED);
    expect('error' in snapshot && snapshot.error).toBeInstanceOf(ConfigError);
  });
});

describe('readProjectServers non-Error failures', () => {
  it('a non-Error thrown while reading .mcp.json becomes a ConfigError', async () => {
    const tree = makeTree();
    const file = writeJson(mcpJsonPath(tree), { mcpServers: {} });
    const real = fs.promises.readFile;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((target: fs.PathLike, options?: unknown) =>
      String(target) === file ? Promise.reject('a thrown string') : real(target, options as never)) as typeof fs.promises.readFile);
    const outcome = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { PATH: '/usr/bin:/bin' } }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ConfigError);
    expect((outcome as Error).cause).toBe('a thrown string');
  });
});
