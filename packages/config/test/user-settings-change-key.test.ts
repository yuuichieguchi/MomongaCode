import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, createUserSettingsCache, noKeptRecords, userSettingsChangeKey } from '@momonga/config';
import { withTempDir } from '@momonga/testkit';

const NOT_ABORTED = new AbortController().signal;

const settingsFileOf = (home: string): string => path.join(home, '.momonga', 'settings.json');

const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

const writeSettings = (home: string, text: string): string => {
  const file = settingsFileOf(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
  return file;
};

const statValuesOf = (file: string): string => {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
};

const cacheOf = (home: string) => createUserSettingsCache({ env: process.env, home, onWarning: () => undefined, keptRecords: noKeptRecords });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config: userSettingsChangeKey', () => {
  it('is the same for the same content in two files with different stat values', async (context) => {
    const first = withTempDir(context);
    const second = withTempDir(context);
    const text = '{ "autoUpdates": false }\n';
    const firstFile = writeSettings(first, text);
    const secondFile = writeSettings(second, text);
    expect(statValuesOf(firstFile)).not.toBe(statValuesOf(secondFile));
    expect(await userSettingsChangeKey(first, NOT_ABORTED)).toBe(await userSettingsChangeKey(second, NOT_ABORTED));
  });

  it('changes when the file is rewritten in place with the same length and the same stat values', async (context) => {
    const home = withTempDir(context);
    const file = writeSettings(home, '{ "autoUpdates": false }\n');
    const statBefore = statValuesOf(file);
    const before = await userSettingsChangeKey(home, NOT_ABORTED);
    writeSettings(home, '{ "autoUpdates": true  }\n');
    expect(statValuesOf(file)).toBe(statBefore);
    expect(await userSettingsChangeKey(home, NOT_ABORTED)).not.toBe(before);
  });

  it('is missing for a missing file', async (context) => {
    expect((await userSettingsChangeKey(withTempDir(context), NOT_ABORTED))).toBe('missing');
  });
});

describe('config: the user-settings cache is keyed on the content of the file', () => {
  it('sees an in-place rewrite of the same length and the same stat values on the next load', async (context) => {
    const home = withTempDir(context);
    const file = writeSettings(home, '{ "autoUpdates": false }\n');
    const cache = cacheOf(home);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.autoUpdates).toBe(false);
    const statBefore = statValuesOf(file);
    writeSettings(home, '{ "autoUpdates": true  }\n');
    expect(statValuesOf(file)).toBe(statBefore);
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.autoUpdates).toBe(true);
  });

  it('parses an invalid file once while its content is unchanged', async (context) => {
    const home = withTempDir(context);
    const text = '{ "tui": { "theme": "bogus" } }\n';
    writeSettings(home, text);
    const parse = vi.spyOn(JSON, 'parse');
    const parsesOfTheFile = (): number => parse.mock.calls.filter(([written]) => written === text).length;
    const cache = cacheOf(home);
    const first = await cache.load(NOT_ABORTED);
    const second = await cache.load(NOT_ABORTED);
    await expect(cache.loadOrKeep(NOT_ABORTED)).rejects.toThrow(ConfigError);
    expect('error' in first && first.error).toBeInstanceOf(ConfigError);
    expect(second).toBe(first);
    expect(parsesOfTheFile()).toBe(1);
  });

  it('parses an invalid file again when its content changes', async (context) => {
    const home = withTempDir(context);
    writeSettings(home, '{ "tui": { "theme": "bogus" } }\n');
    const cache = cacheOf(home);
    expect('error' in (await cache.load(NOT_ABORTED))).toBe(true);
    writeSettings(home, '{ "autoUpdates": false           }\n');
    expect((await cache.loadOrKeep(NOT_ABORTED)).settings.autoUpdates).toBe(false);
  });
});
