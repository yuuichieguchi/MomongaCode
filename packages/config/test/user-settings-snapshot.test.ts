import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, createUserSettingsCache, loadMcpServers, loadSettings, noKeptRecords } from '@momonga/config';
import type { UserLayer, UserSettingsSnapshot } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';

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

describe('UserSettingsCache.snapshot', () => {
  it('snapshot returns settings and the user layer after a good load', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'user' }, autoUpdates: false }, T0);
    const { cache } = cacheFor(tree);
    const snapshot = settingsOf(cache.snapshot());
    expect(snapshot.settings.env).toEqual({ TZ: 'user' });
    expect(snapshot.settings.autoUpdates).toBe(false);
    expect(snapshot.user.layer?.source).toBe(file);
    expect(snapshot.user.layer?.origin).toBe('user');
    expect(snapshot.user.layer?.settings).toEqual({ env: { TZ: 'user' }, autoUpdates: false });
    expect(snapshot.user.models.targets).toEqual({});
    expect(snapshot.user.warnings).toEqual([]);
  });

  it('a failed reload makes snapshot return { error: ConfigError } while get() keeps the last good settings', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    expect(settingsOf(cache.snapshot()).settings.env).toEqual({ TZ: 'good' });
    writeTextAt(file, '{ broken', T1);
    const error = errorOf(cache.snapshot());
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(file);
    expect(cache.get().env).toEqual({ TZ: 'good' });
    expect(warnings.some((message) => message.startsWith('settings file is invalid: ') && message.includes(file))).toBe(true);
    expect(warnings.some((message) => message.includes('keeping') || message.includes('last good'))).toBe(false);
  });

  it('a later good load replaces the error', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache } = cacheFor(tree);
    cache.snapshot();
    writeTextAt(file, '{ broken', T1);
    expect(errorOf(cache.snapshot())).toBeInstanceOf(ConfigError);
    writeAt(file, { env: { TZ: 'fixed' } }, T2);
    expect(settingsOf(cache.snapshot()).settings.env).toEqual({ TZ: 'fixed' });
    expect(cache.get().env).toEqual({ TZ: 'fixed' });
  });

  it('a failed load is never cached, so fixing the cause restores service without touching the file', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    const extra = path.join(tree.home, 'extra');
    writeAt(file, { permissions: { additionalDirectories: [extra] } }, T0);
    const { cache } = cacheFor(tree);
    expect(errorOf(cache.snapshot())).toBeInstanceOf(ConfigError);
    fs.mkdirSync(extra);
    expect(settingsOf(cache.snapshot()).settings.permissions.additionalDirectories).toEqual([extra]);
  });

  it('a non-ConfigError failure is wrapped as ConfigError with cause', () => {
    const tree = makeTree();
    writeText(path.join(tree.home, '.momonga'), 'not a directory');
    const { cache } = cacheFor(tree);
    const error = errorOf(cache.snapshot());
    expect(error).toBeInstanceOf(ConfigError);
    expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe('ENOTDIR');
  });

  it('get() throws ConfigError when there are no last-good settings', () => {
    const tree = makeTree();
    writeText(path.join(tree.home, '.momonga'), 'not a directory');
    const { cache } = cacheFor(tree);
    expect(errorOf(cache.snapshot())).toBeInstanceOf(ConfigError);
    expect(() => cache.get()).toThrow(ConfigError);
  });

  it('get() throws ConfigError after an initial parse failure seen through snapshot', () => {
    const tree = makeTree();
    writeTextAt(userSettingsPath(tree), '{ broken', T0);
    const { cache } = cacheFor(tree);
    expect(errorOf(cache.snapshot())).toBeInstanceOf(ConfigError);
    expect(() => cache.get()).toThrow(ConfigError);
  });

  it('get() and snapshot() reload once per file change', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { unknownSettingForCount: 1 }, T0);
    const { cache, warnings } = cacheFor(tree);
    const reloads = (): number => warnings.filter((message) => message.includes('unknownSettingForCount')).length;
    cache.get();
    cache.snapshot();
    cache.get();
    cache.snapshot();
    expect(reloads()).toBe(1);
    writeAt(file, { unknownSettingForCount: 2 }, T1);
    cache.snapshot();
    cache.get();
    cache.snapshot();
    expect(reloads()).toBe(2);
  });

  it('snapshot never throws', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeTextAt(file, '{ broken', T0);
    const { cache } = cacheFor(tree);
    expect(() => cache.snapshot()).not.toThrow();
    fs.rmSync(path.join(tree.home, '.momonga'), { recursive: true, force: true });
    writeText(path.join(tree.home, '.momonga'), 'not a directory');
    expect(() => cache.snapshot()).not.toThrow();
    expect(errorOf(cache.snapshot())).toBeInstanceOf(ConfigError);
  });
});

describe('loaders taking a user layer', () => {
  const snapshotUser = (tree: Tree): UserLayer => {
    const { cache } = cacheFor(tree);
    return settingsOf(cache.snapshot()).user;
  };

  it('loadSettings with a user layer does not read the user settings file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'snapshot' }, autoUpdates: false }, T0);
    const user = snapshotUser(tree);
    fs.rmSync(file);
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree), user });
    expect(result.settings.env).toEqual({ TZ: 'snapshot' });
    expect(result.settings.autoUpdates).toBe(false);
    expect(result.files).toContain(file);
  });

  it('loadSettings with a user layer ignores a rewritten user settings file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'snapshot' } }, T0);
    const user = snapshotUser(tree);
    writeAt(file, { env: { TZ: 'rewritten' } }, T1);
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree), user });
    expect(result.settings.env).toEqual({ TZ: 'snapshot' });
  });

  it('loadSettings without a user layer still reads the user settings file', async () => {
    const tree = makeTree();
    writeAt(userSettingsPath(tree), { env: { TZ: 'file' } }, T0);
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.env).toEqual({ TZ: 'file' });
  });

  it('loadMcpServers with a user layer does not read the user settings file', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { mcpServers: { snap: { command: 'snap-server' } } }, T0);
    const user = snapshotUser(tree);
    fs.rmSync(file);
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, user });
    expect(result.enabled.map((entry) => [entry.name, entry.scope, entry.config])).toEqual([['snap', 'user', { command: 'snap-server' }]]);
  });
});

describe('warnings for a broken user settings file', () => {
  const invalidFileWarnings = (warnings: readonly string[]): string[] => warnings.filter((message) => message.startsWith('settings file is invalid: '));

  it('warns once per failure while the file stays broken', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    cache.get();
    writeTextAt(file, '{ broken', T1);
    cache.get();
    cache.snapshot();
    cache.get();
    cache.snapshot();
    cache.get();
    expect(invalidFileWarnings(warnings)).toHaveLength(1);
    expect(invalidFileWarnings(warnings)[0]).toContain(file);
  });

  it('warns again when the error message changes', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    cache.get();
    writeTextAt(file, '{ broken', T1);
    cache.get();
    cache.snapshot();
    writeAt(file, { permissions: { allow: 'Bash(ls)' } }, T2);
    cache.get();
    cache.snapshot();
    cache.get();
    expect(invalidFileWarnings(warnings)).toHaveLength(2);
  });

  it('warns again when the file identity changes with the same error', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const { cache, warnings } = cacheFor(tree);
    cache.get();
    writeTextAt(file, '{ broken', T1);
    cache.get();
    cache.snapshot();
    writeTextAt(file, '{ broken', T2);
    cache.snapshot();
    cache.get();
    expect(invalidFileWarnings(warnings)).toHaveLength(2);
  });

  it('the warning states the problem and no policy', () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeAt(file, { env: { TZ: 'good' } }, T0);
    const getConsumer = cacheFor(tree);
    const snapshotConsumer = cacheFor(tree);
    getConsumer.cache.get();
    snapshotConsumer.cache.snapshot();
    writeTextAt(file, '{ broken', T1);
    getConsumer.cache.get();
    const error = errorOf(snapshotConsumer.cache.snapshot());
    expect(getConsumer.warnings).toEqual([`settings file is invalid: ${error.message}`]);
    expect(snapshotConsumer.warnings).toEqual(getConsumer.warnings);
    expect(getConsumer.warnings[0]).toContain(file);
    for (const message of getConsumer.warnings) {
      expect(message).not.toContain('keeping');
      expect(message).not.toContain('last good');
    }
  });
});
