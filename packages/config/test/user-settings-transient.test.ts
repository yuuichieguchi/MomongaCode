import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, createUserSettingsCache, loadMcpServers, noKeptRecords } from '@momonga/config';
import { makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:00:10Z');

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

const writeAt = (file: string, value: unknown, at: Date): void => {
  writeJson(file, value);
  fs.utimesSync(file, at, at);
};

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
};

type Fault = { error?: Error };

const faultLstat = (target: string, fault: Fault): void => {
  const real = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: unknown) => {
    if (String(file) === target && fault.error !== undefined) throw fault.error;
    return real(file, options as never);
  }) as typeof fs.lstatSync);
};

const faultRead = (target: string, fault: Fault): void => {
  const real = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(file) === target && fault.error !== undefined) throw fault.error;
    return real(file, options as never);
  }) as typeof fs.readFileSync);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserSettingsCache with a transient errno after a good load', () => {
  for (const site of ['lstat', 'read'] as const) {
    it(`get() keeps the last good settings and snapshot() throws the same EMFILE when the ${site} fails`, () => {
      const tree = makeTree();
      const file = userSettingsPath(tree);
      writeAt(file, { env: { TZ: 'good' } }, T0);
      const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
      expect(cache.get().env).toEqual({ TZ: 'good' });

      writeAt(file, { env: { TZ: 'newer' } }, T1);
      const fault: Fault = { error: errnoError('EMFILE') };
      if (site === 'lstat') faultLstat(file, fault);
      else faultRead(file, fault);

      expect(thrownBy(() => cache.get())).toBeUndefined();
      expect(cache.get().env).toEqual({ TZ: 'good' });
      expect(thrownBy(() => cache.snapshot())).toBe(fault.error);
      expect(thrownBy(() => cache.snapshot())).toBe(fault.error);

      delete fault.error;
      const snapshot = cache.snapshot();
      expect('error' in snapshot).toBe(false);
      expect(cache.get().env).toEqual({ TZ: 'newer' });
    });
  }

  it('get() throws the transient error when there was no prior good load', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const fault: Fault = { error: errnoError('EMFILE') };
    faultRead(file, fault);
    const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
    expect(thrownBy(() => cache.get())).toBe(fault.error);
    delete fault.error;
    expect(cache.get().env).toEqual({ TZ: 'good' });
  });

  it('a non-transient errno (EACCES) still becomes a ConfigError snapshot', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, {}, T0);
    faultRead(file, { error: errnoError('EACCES') });
    const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
    const snapshot = cache.snapshot();
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
