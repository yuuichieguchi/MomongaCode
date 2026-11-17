import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  ModelsEditRefused,
  createStopValuesReader,
  createUserSettingsCache,
  diskKeptRecords,
  editModelsSettings,
  editSettings,
  keptSettingsDirectory,
  loadSettings,
  loadUserModels,
  loadUserSettings,
  noKeptRecords,
  readUserStopValues,
  userSettingsChangeKey,
  writeAppliedRecord,
} from '@momonga/config';
import { DEFAULT_STOP_VALUES, nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { makeTree, projectSettingsPath, userSettingsPath, writeJson, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const unaborted = (): AbortSignal => new AbortController().signal;

const abortedWith = (reason: Error): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

type CountedFiles = { files: FileSystem; calls: string[] };

const countedFiles = (): CountedFiles => {
  const calls: string[] = [];
  const files = new Proxy(nodeFileSystem, {
    get: (target, name, receiver) => {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== 'function' || typeof name !== 'string') return member;
      return (...given: unknown[]): unknown => {
        calls.push(name);
        return (member as (...values: unknown[]) => unknown).apply(target, given);
      };
    },
  });
  return { files, calls };
};

const SYNCHRONOUS_NAME = /Sync$/;

const FOUNDATION_LOCK_OR_ATOMIC_WRITE = /foundation\/src\/(atomic-file|file-lock|platform\/)/;

const synchronousFileCalls = (): (() => string[]) => {
  const called: string[] = [];
  const host = fs as unknown as Record<string, unknown>;
  for (const name of Object.keys(host)) {
    if (!SYNCHRONOUS_NAME.test(name) || typeof host[name] !== 'function') continue;
    const real = host[name] as (...given: unknown[]) => unknown;
    vi.spyOn(host as Record<string, (...given: unknown[]) => unknown>, name).mockImplementation((...given: unknown[]) => {
      if (!FOUNDATION_LOCK_OR_ATOMIC_WRITE.test(new Error('call site').stack ?? '')) called.push(name);
      return real(...given);
    });
  }
  return () => called;
};

const trustingAll = { isTrusted: (): boolean => true };

const socketConnection = (socketPath: string) => ({ adapter: 'chat-completions', provider: 'home', socketPath, models: [{ id: 'm', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] });

const cacheOf = (tree: Tree, files?: FileSystem) => {
  const warnings: string[] = [];
  const cache = createUserSettingsCache({ env: process.env, home: tree.home, onWarning: (message) => warnings.push(message), keptRecords: noKeptRecords, ...(files === undefined ? {} : { files }) });
  return { cache, warnings };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config: settings are loaded asynchronously, through the file-system port, under the signal of the asker', () => {
  it('stops a load whose signal is already aborted before it reads any file', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { autoUpdates: false });
    writeJson(projectSettingsPath(tree), { env: { TZ: 'project' } });
    const reason = new Error('the asker left');
    const counted = countedFiles();
    const synchronous = synchronousFileCalls();
    await expect(loadSettings({ env: process.env, signal: abortedWith(reason), home: tree.home, projectDir: tree.project, cli: {}, trust: trustingAll, files: counted.files })).rejects.toBe(reason);
    expect(counted.calls).toEqual([]);
    expect(synchronous()).toEqual([]);
  });

  it('makes no synchronous file call while it loads the layers of a project', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { autoUpdates: false, permissions: { additionalDirectories: [tree.project] } });
    writeJson(projectSettingsPath(tree), { env: { TZ: 'project' } });
    const counted = countedFiles();
    const synchronous = synchronousFileCalls();
    const loaded = await loadSettings({ env: process.env, signal: unaborted(), home: tree.home, projectDir: tree.project, cli: {}, trust: trustingAll, files: counted.files });
    expect(synchronous()).toEqual([]);
    expect(loaded.settings.env).toEqual({ TZ: 'project' });
    expect(loaded.settings.autoUpdates).toBe(false);
    expect(counted.calls).toContain('readTextFile');
  });

  it('makes no synchronous file call while it loads the user settings, the user models, the stop values and the change key', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { gateway: { closeGraceMs: 1234 }, models: { connections: [socketConnection(path.join(tree.project, 'model.sock'))] } });
    const synchronous = synchronousFileCalls();
    const signal = unaborted();
    const settings = await loadUserSettings({ env: process.env, home: tree.home, signal });
    const models = await loadUserModels({ home: tree.home, signal });
    const stop = await readUserStopValues(tree.home, process.env, signal);
    const key = await userSettingsChangeKey(tree.home, signal);
    expect(synchronous()).toEqual([]);
    expect(settings.settings.gateway.closeGraceMs).toBe(1234);
    expect(models.resolved.connections).toHaveLength(1);
    expect(stop.closeGraceMs).toBe(1234);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses at load a socket inside the run directory of the home, by the resolved path', async () => {
    const tree = makeTree();
    const run = path.join(tree.home, '.momonga', 'run');
    fs.mkdirSync(run, { recursive: true });
    const link = path.join(tree.project, 'run-link');
    fs.symlinkSync(run, link);
    writeJson(userSettingsPath(tree), { models: { connections: [socketConnection(path.join(link, 'own.sock'))] } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: unaborted() })).rejects.toThrow(/models\.connections\[0\]: socketPath .* must not be inside /);
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: unaborted() })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('config: the models writer refuses what the loader refuses about a socket', () => {
  it('writes no socket address that resolves inside the run directory of the home', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    const before = { models: { connections: [socketConnection(path.join(tree.project, 'model.sock'))] } };
    writeJson(file, before);
    const run = path.join(tree.home, '.momonga', 'run');
    fs.mkdirSync(run, { recursive: true });
    const link = path.join(tree.project, 'run-link');
    fs.symlinkSync(run, link);
    const edit = editModelsSettings(tree.home, file, [{ kind: 'setConnectionField', provider: 'home', path: ['socketPath'], value: path.join(link, 'own.sock') }], { lock: testKernelLock(), signal: unaborted() });
    await expect(edit).rejects.toBeInstanceOf(ModelsEditRefused);
    await expect(edit).rejects.toMatchObject({ code: 'would_not_load', message: expect.stringMatching(/^Not saved: models\.connections\[0\]: socketPath .* must not be inside /) });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before);
  });
});

describe('config: the user-settings cache keeps the last loaded snapshot in memory', () => {
  it('shows a change of the file to the load of the next request and not to a plain reader before it', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false });
    const counted = countedFiles();
    const { cache } = cacheOf(tree, counted.files);
    await cache.load(unaborted());
    expect(cache.get().autoUpdates).toBe(false);
    writeJson(file, { autoUpdates: true });
    const before = counted.calls.length;
    const synchronous = synchronousFileCalls();
    expect(cache.get().autoUpdates).toBe(false);
    expect(cache.read().settings.autoUpdates).toBe(false);
    const snapshot = cache.snapshot();
    expect('error' in snapshot ? undefined : snapshot.settings.autoUpdates).toBe(false);
    expect(counted.calls.length).toBe(before);
    expect(synchronous()).toEqual([]);
    await cache.load(unaborted());
    expect(cache.get().autoUpdates).toBe(true);
  });

  it('refuses a plain reader before the first load, without reading the file', () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { autoUpdates: false });
    const counted = countedFiles();
    const { cache } = cacheOf(tree, counted.files);
    const synchronous = synchronousFileCalls();
    expect(() => cache.snapshot()).toThrow('the user settings were read before their first load');
    expect(() => cache.get()).toThrow('the user settings were read before their first load');
    expect(counted.calls).toEqual([]);
    expect(synchronous()).toEqual([]);
  });

  it('ends a load with the reason of its signal and keeps the snapshot it had', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false });
    const { cache } = cacheOf(tree);
    await cache.load(unaborted());
    writeJson(file, { autoUpdates: true });
    const reason = new Error('the asker left');
    await expect(cache.load(abortedWith(reason))).rejects.toBe(reason);
    expect(cache.get().autoUpdates).toBe(false);
  });

  it('gives the loaded settings to the one who asked to be told, once per content', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { gateway: { closeGraceMs: 1111 } });
    const told: number[] = [];
    const cache = createUserSettingsCache({ env: process.env, home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords, onLoaded: ({ settings }) => told.push(settings.gateway.closeGraceMs) });
    await cache.load(unaborted());
    await cache.load(unaborted());
    writeJson(file, { gateway: { closeGraceMs: 2222 } });
    await cache.load(unaborted());
    writeText(file, '{ broken');
    await cache.load(unaborted());
    expect(told).toEqual([1111, 2222]);
  });

  it('keeps the last good settings for loadOrKeep while the file is invalid, and fails it when there are none', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false });
    const { cache } = cacheOf(tree);
    expect((await cache.loadOrKeep(unaborted())).settings.autoUpdates).toBe(false);
    writeText(file, '{ broken');
    expect((await cache.loadOrKeep(unaborted())).settings.autoUpdates).toBe(false);
    const fresh = cacheOf(tree);
    await expect(fresh.cache.loadOrKeep(unaborted())).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('config: the settings writers write asynchronously under the signal of the asker', () => {
  it('leaves the user settings file unchanged when the signal of an edit is aborted', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeText(file, '{"autoUpdates":false}');
    const reason = new Error('the asker left');
    await expect(editSettings({ home: tree.home, projectDir: tree.project }, 'user', { kind: 'set', path: ['autoUpdates'], value: true }, { env: process.env, trusted: true, lock: testKernelLock(), signal: abortedWith(reason) })).rejects.toBe(reason);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"autoUpdates":false}');
  });

  it('makes no synchronous file call of its own during an edit (the lock and the atomic write of the foundation aside)', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false });
    const synchronous = synchronousFileCalls();
    await editSettings({ home: tree.home, projectDir: tree.project }, 'project', { kind: 'set', path: ['env', 'TZ'], value: 'UTC' }, { env: process.env, trusted: true, lock: testKernelLock(), signal: unaborted() });
    await editSettings({ home: tree.home, projectDir: tree.project }, 'user', { kind: 'set', path: ['autoUpdates'], value: true }, { env: process.env, trusted: true, lock: testKernelLock(), signal: unaborted() });
    expect(synchronous()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ autoUpdates: true });
  });

  it('writes no applied record when the signal is aborted, and writes it asynchronously otherwise', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { autoUpdates: false });
    const record = path.join(tree.home, '.momonga', 'run', 'settings-applied.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    const reason = new Error('the asker left');
    await expect(writeAppliedRecord(tree.home, record, undefined, { env: process.env, signal: abortedWith(reason), random: systemRandom, lock: testKernelLock() })).rejects.toBe(reason);
    expect(fs.existsSync(record)).toBe(false);
    const synchronous = synchronousFileCalls();
    const written = await writeAppliedRecord(tree.home, record, undefined, { env: process.env, signal: unaborted(), random: systemRandom, lock: testKernelLock() });
    expect(synchronous()).toEqual([]);
    expect(written).toEqual({ kind: 'written', seq: 1 });
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual({ seq: 1, settings: { autoUpdates: false } });
  });

  it('keeps and recalls a last good copy through the asynchronous port', async () => {
    const tree = makeTree();
    const directory = keptSettingsDirectory(tree.home);
    const counted = countedFiles();
    const records = diskKeptRecords(counted.files, systemRandom, directory, testKernelLock());
    const synchronous = synchronousFileCalls();
    expect(await records.load('/some/settings.json', unaborted())).toBeUndefined();
    await records.save('/some/settings.json', { found: true, value: { autoUpdates: false } }, unaborted());
    expect(await records.load('/some/settings.json', unaborted())).toEqual({ found: true, value: { autoUpdates: false } });
    expect(synchronous()).toEqual([]);
    const reason = new Error('the asker left');
    await expect(records.save('/other/settings.json', { found: false }, abortedWith(reason))).rejects.toBe(reason);
    expect(await records.load('/other/settings.json', unaborted())).toBeUndefined();
  });
});

describe('config: the stop path reads the values in memory', () => {
  it('gives the values last remembered, and the default values with one notice when none were', () => {
    const notices: string[] = [];
    const reader = createStopValuesReader({ onNotice: (message) => notices.push(message) });
    const synchronous = synchronousFileCalls();
    expect(reader.read()).toEqual(DEFAULT_STOP_VALUES);
    expect(reader.read()).toEqual(DEFAULT_STOP_VALUES);
    expect(notices).toEqual(['the stop values were not loaded from the user settings before the stop; the default values were used']);
    const remembered = { ...DEFAULT_STOP_VALUES, closeGraceMs: 4321 };
    reader.remember(remembered);
    expect(reader.read()).toEqual(remembered);
    expect(notices).toHaveLength(1);
    expect(synchronous()).toEqual([]);
  });
});
