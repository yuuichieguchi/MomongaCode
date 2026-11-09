import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, createUserSettingsCache, loadMcpServers, loadSettings, loadUserSettings, noKeptRecords } from '@momonga/config';
import { localSettingsPath, makeTree, mcpJsonPath, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

afterEach(() => {
  vi.restoreAllMocks();
});

const failAsyncRead = (target: string, error: Error): void => {
  const real = fs.promises.readFile;
  vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: fs.PathLike, options?: unknown) =>
    String(file) === target ? Promise.reject(error) : real(file, options as never)) as typeof fs.promises.readFile);
};

const failSyncRead = (target: string, error: Error): void => {
  const real = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(file) === target) throw error;
    return real(file, options as never);
  }) as typeof fs.readFileSync);
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

const load = (tree: Tree) => loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });

describe('config transient errno propagation', () => {
  for (const code of ['EMFILE', 'EIO']) {
    it(`${code} reading the project settings file rejects loadSettings with the same error`, async () => {
      const tree = makeTree();
      const file = writeJson(projectSettingsPath(tree), { permissions: { allow: ['Read'] } });
      const injected = errnoError(code);
      failAsyncRead(file, injected);
      const error = await rejectionOf(load(tree));
      expect(error).toBe(injected);
      expect(error).not.toBeInstanceOf(ConfigError);
    });

    it(`${code} reading the local settings file rejects loadSettings with the same error`, async () => {
      const tree = makeTree();
      const file = writeJson(localSettingsPath(tree), { permissions: { allow: ['Read'] } });
      const injected = errnoError(code);
      failAsyncRead(file, injected);
      const error = await rejectionOf(load(tree));
      expect(error).toBe(injected);
    });

    it(`${code} reading .mcp.json rejects loadMcpServers with the same error`, async () => {
      const tree = makeTree();
      const file = writeJson(mcpJsonPath(tree), { mcpServers: { demo: { command: '/bin/echo' } } });
      const injected = errnoError(code);
      failAsyncRead(file, injected);
      const error = await rejectionOf(loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { PATH: '/usr/bin:/bin' } }));
      expect(error).toBe(injected);
    });

    it(`${code} reading the user settings file rejects loadUserSettings and throws from snapshot() with the same error`, async () => {
      const tree = makeTree();
      const file = writeJson(userSettingsPath(tree), { permissions: { allow: ['Read'] } });
      const injected = errnoError(code);
      failSyncRead(file, injected);
      expect(await rejectionOf(loadUserSettings({ home: tree.home }))).toBe(injected);
      const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
      let thrown: unknown;
      try {
        cache.snapshot();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(injected);
    });
  }

  it('EACCES on the project settings file still rejects with a ConfigError', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { allow: ['Read'] } });
    const injected = errnoError('EACCES');
    failAsyncRead(file, injected);
    const error = await rejectionOf(load(tree));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).cause).toBe(injected);
  });

  it('EACCES on the user settings file is a ConfigError', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), {});
    failSyncRead(file, errnoError('EACCES'));
    expect(await rejectionOf(loadUserSettings({ home: tree.home }))).toBeInstanceOf(ConfigError);
    const snapshot = createUserSettingsCache({ home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords }).snapshot();
    expect('error' in snapshot && snapshot.error).toBeInstanceOf(ConfigError);
  });
});
