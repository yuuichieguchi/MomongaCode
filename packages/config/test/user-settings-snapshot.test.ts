import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, createUserSettingsCache, loadMcpServers, loadSettings, noKeptRecords } from '@momonga/config';
import type { UserLayer, UserSettingsSnapshot } from '@momonga/config';
import { canonsOf, makeTree, trusting, userSettingsPath, writeJson, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';

const NOT_ABORTED = new AbortController().signal;

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:00:10Z');
const T2 = new Date('2026-01-01T00:00:20Z');

const writeAt = (file: string, value: unknown, at: Date): void => {
  writeJson(file, value);
  fs.utimesSync(file, at, at);
};

const writeTextAt = (file: string, text: string, at: Date): void => {
  writeText(file, text);
  fs.utimesSync(file, at, at);
};

const cacheFor = (tree: Tree) => {
  const warnings: string[] = [];
  const cache = createUserSettingsCache({ home: tree.home, onWarning: (message) => warnings.push(message), keptRecords: noKeptRecords });
  return { cache, warnings };
};

const settingsOf = (snapshot: UserSettingsSnapshot) => {
  if ('error' in snapshot) throw new Error(`expected settings, got error ${snapshot.error.message}`);
  return snapshot;
};

const errorOf = (snapshot: UserSettingsSnapshot): ConfigError => {
  if (!('error' in snapshot)) throw new Error('expected an error snapshot');
  return snapshot.error;
};

describe('UserSettingsCache.load', () => {
  it('load returns settings and the user layer after a good load', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'user' }, autoUpdates: false }, T0);
    const { cache } = cacheFor(tree);
    const snapshot = settingsOf(await cache.load(NOT_ABORTED));
    expect(snapshot.settings.env).toEqual({ TZ: 'user' });
    expect(snapshot.settings.autoUpdates).toBe(false);
    expect(snapshot.user.layer?.source).toBe(file);
    expect(snapshot.user.layer?.origin).toBe('user');
    expect(snapshot.user.layer?.settings).toEqual({ env: { TZ: 'user' }, autoUpdates: false });
    expect(canonsOf({ models: snapshot.user.models })).toEqual([]);
    expect(snapshot.user.warnings).toEqual([]);
  });

  it('a failed reload makes load return { error: ConfigError } while loadOrKeep keeps the last good settings', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    expect(settingsOf(await cache.load(NOT_ABORTED)).settings.env).toEqual({ TZ: 'good' });
    writeTextAt(file, '{ broken', T1);
    const error = errorOf(await cache.load(NOT_ABORTED));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(file);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ TZ: 'good' });
    expect(warnings.some((message) => message.startsWith('settings file is invalid: ') && message.includes(file))).toBe(true);
    expect(warnings.some((message) => message.includes('keeping') || message.includes('last good'))).toBe(false);
  });

  it('a later good load replaces the error', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache } = cacheFor(tree);
    await cache.load(NOT_ABORTED);
    writeTextAt(file, '{ broken', T1);
    expect(errorOf(await cache.load(NOT_ABORTED))).toBeInstanceOf(ConfigError);
    writeAt(file, { env: { TZ: 'fixed' } }, T2);
    expect(settingsOf(await cache.load(NOT_ABORTED)).settings.env).toEqual({ TZ: 'fixed' });
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.env).toEqual({ TZ: 'fixed' });
  });

  it('a failed load is cached under the content of the file, and a changed content loads', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { tui: { theme: 'bogus' } }, T0);
    const { cache } = cacheFor(tree);
    const failed = await cache.load(NOT_ABORTED);
    expect(errorOf(failed)).toBeInstanceOf(ConfigError);
    writeAt(file, { tui: { theme: 'bogus' } }, T1);
    expect(await cache.load(NOT_ABORTED)).toBe(failed);
    writeAt(file, { autoUpdates: false }, T1);
    expect(settingsOf(await cache.load(NOT_ABORTED)).settings.autoUpdates).toBe(false);
  });

  it('a non-ConfigError failure is wrapped as ConfigError with cause', async () => {
    const tree = makeTree();
    writeText(path.join(tree.home, '.momonga'), 'not a directory');
    const { cache } = cacheFor(tree);
    const error = errorOf(await cache.load(NOT_ABORTED));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe('ENOTDIR');
  });

  it('loadOrKeep throws ConfigError when there are no last-good settings', async () => {
    const tree = makeTree();
    writeText(path.join(tree.home, '.momonga'), 'not a directory');
    const { cache } = cacheFor(tree);
    expect(errorOf(await cache.load(NOT_ABORTED))).toBeInstanceOf(ConfigError);
    await expect(cache.loadOrKeep(NOT_ABORTED)).rejects.toThrow(ConfigError);
  });

  it('loadOrKeep throws ConfigError after an initial parse failure seen through snapshot', async () => {
    const tree = makeTree();
    writeTextAt(userSettingsPath(tree), '{ broken', T0);
    const { cache } = cacheFor(tree);
    expect(errorOf(await cache.load(NOT_ABORTED))).toBeInstanceOf(ConfigError);
    await expect(cache.loadOrKeep(NOT_ABORTED)).rejects.toThrow(ConfigError);
  });

  it('loadOrKeep and load reload once per file change', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { unknownSettingForCount: 1 }, T0);
    const { cache, warnings } = cacheFor(tree);
    const reloads = (): number => warnings.filter((message) => message.includes('unknownSettingForCount')).length;
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    expect(reloads()).toBe(1);
    writeAt(file, { unknownSettingForCount: 2 }, T1);
    await cache.load(NOT_ABORTED);
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    expect(reloads()).toBe(2);
  });

  it('load never rejects for an invalid file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeTextAt(file, '{ broken', T0);
    const { cache } = cacheFor(tree);
    await expect(cache.load(NOT_ABORTED)).resolves.toBeDefined();
    fs.rmSync(path.join(tree.home, '.momonga'), { recursive: true, force: true });
    writeText(path.join(tree.home, '.momonga'), 'not a directory');
    await expect(cache.load(NOT_ABORTED)).resolves.toBeDefined();
    expect(errorOf(await cache.load(NOT_ABORTED))).toBeInstanceOf(ConfigError);
  });
});

describe('loaders taking a user layer', () => {
  const snapshotUser = async (tree: Tree): Promise<UserLayer> => {
    const { cache } = cacheFor(tree);
    return settingsOf(await cache.load(NOT_ABORTED)).user;
  };

  it('loadSettings with a user layer does not read the user settings file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'snapshot' }, autoUpdates: false }, T0);
    const user = await snapshotUser(tree);
    fs.rmSync(file);
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree), user });
    expect(result.settings.env).toEqual({ TZ: 'snapshot' });
    expect(result.settings.autoUpdates).toBe(false);
    expect(result.files).toContain(file);
  });

  it('loadSettings with a user layer ignores a rewritten user settings file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'snapshot' } }, T0);
    const user = await snapshotUser(tree);
    writeAt(file, { env: { TZ: 'rewritten' } }, T1);
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree), user });
    expect(result.settings.env).toEqual({ TZ: 'snapshot' });
  });

  it('loadSettings without a user layer still reads the user settings file', async () => {
    const tree = makeTree();
    writeAt(userSettingsPath(tree), { env: { TZ: 'file' } }, T0);
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.env).toEqual({ TZ: 'file' });
  });

  it('loadMcpServers with a user layer does not read the user settings file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { mcpServers: { snap: { command: 'snap-server' } } }, T0);
    const user = await snapshotUser(tree);
    fs.rmSync(file);
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, user });
    expect(result.enabled.map((entry) => [entry.name, entry.scope, entry.config])).toEqual([['snap', 'user', { command: 'snap-server' }]]);
  });
});

describe('warnings for a broken user settings file', () => {
  const invalidFileWarnings = (warnings: readonly string[]): string[] => warnings.filter((message) => message.startsWith('settings file is invalid: '));

  it('warns once per failure while the file stays broken', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    await cache.loadOrKeep(NOT_ABORTED);
    writeTextAt(file, '{ broken', T1);
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    await cache.loadOrKeep(NOT_ABORTED);
    expect(invalidFileWarnings(warnings)).toHaveLength(1);
    expect(invalidFileWarnings(warnings)[0]).toContain(file);
  });

  it('warns again when the error message changes', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    await cache.loadOrKeep(NOT_ABORTED);
    writeTextAt(file, '{ broken', T1);
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    writeAt(file, { permissions: { allow: 'Bash(ls)' } }, T2);
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    await cache.loadOrKeep(NOT_ABORTED);
    expect(invalidFileWarnings(warnings)).toHaveLength(2);
  });

  it('warns once when the same content is written again with the same error', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    await cache.loadOrKeep(NOT_ABORTED);
    writeTextAt(file, '{ broken', T1);
    await cache.loadOrKeep(NOT_ABORTED);
    await cache.load(NOT_ABORTED);
    writeTextAt(file, '{ broken', T2);
    await cache.load(NOT_ABORTED);
    await cache.loadOrKeep(NOT_ABORTED);
    expect(invalidFileWarnings(warnings)).toHaveLength(1);
  });

  it('the warning states the problem and no policy', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const getConsumer = cacheFor(tree);
    const snapshotConsumer = cacheFor(tree);
    await getConsumer.cache.loadOrKeep(NOT_ABORTED);
    await snapshotConsumer.cache.load(NOT_ABORTED);
    writeTextAt(file, '{ broken', T1);
    await getConsumer.cache.loadOrKeep(NOT_ABORTED);
    const error = errorOf(await snapshotConsumer.cache.load(NOT_ABORTED));
    expect(getConsumer.warnings).toEqual([`settings file is invalid: ${error.message}`]);
    expect(snapshotConsumer.warnings).toEqual(getConsumer.warnings);
    expect(getConsumer.warnings[0]).toContain(file);
    for (const message of getConsumer.warnings) {
      expect(message).not.toContain('keeping');
      expect(message).not.toContain('last good');
    }
  });
});
