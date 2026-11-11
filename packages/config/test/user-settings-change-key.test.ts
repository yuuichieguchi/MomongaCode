import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, createUserSettingsCache, noKeptRecords, userSettingsChangeKey } from '@momonga/config';
import { withTempDir } from '@momonga/testkit';

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

const cacheOf = (home: string) => createUserSettingsCache({ home, onWarning: () => undefined, keptRecords: noKeptRecords });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config: userSettingsChangeKey', () => {
  it('is the same for the same content in two files with different stat values', (context) => {
    const first = withTempDir(context);
    const second = withTempDir(context);
    const text = '{ "autoUpdates": false }\n';
    const firstFile = writeSettings(first, text);
    const secondFile = writeSettings(second, text);
    expect(statValuesOf(firstFile)).not.toBe(statValuesOf(secondFile));
    expect(userSettingsChangeKey(first)).toBe(userSettingsChangeKey(second));
  });

  it('changes when the file is rewritten in place with the same length and the same stat values', (context) => {
    const home = withTempDir(context);
    const file = writeSettings(home, '{ "autoUpdates": false }\n');
    const statBefore = statValuesOf(file);
    const before = userSettingsChangeKey(home);
    writeSettings(home, '{ "autoUpdates": true  }\n');
    expect(statValuesOf(file)).toBe(statBefore);
    expect(userSettingsChangeKey(home)).not.toBe(before);
  });

  it('is missing for a missing file', (context) => {
    expect(userSettingsChangeKey(withTempDir(context))).toBe('missing');
  });
});

describe('config: the user-settings cache is keyed on the content of the file', () => {
  it('sees an in-place rewrite of the same length and the same stat values on the next load', (context) => {
    const home = withTempDir(context);
    const file = writeSettings(home, '{ "autoUpdates": false }\n');
    const cache = cacheOf(home);
    expect(cache.get().autoUpdates).toBe(false);
    const statBefore = statValuesOf(file);
    writeSettings(home, '{ "autoUpdates": true  }\n');
    expect(statValuesOf(file)).toBe(statBefore);
    expect(cache.get().autoUpdates).toBe(true);
  });

  it('parses an invalid file once while its content is unchanged', (context) => {
    const home = withTempDir(context);
    const text = '{ "tui": { "theme": "bogus" } }\n';
    writeSettings(home, text);
    const parse = vi.spyOn(JSON, 'parse');
    const parsesOfTheFile = (): number => parse.mock.calls.filter(([written]) => written === text).length;
    const cache = cacheOf(home);
    const first = cache.snapshot();
    const second = cache.snapshot();
    expect(() => cache.read()).toThrow(ConfigError);
    expect('error' in first && first.error).toBeInstanceOf(ConfigError);
    expect(second).toBe(first);
    expect(parsesOfTheFile()).toBe(1);
  });

  it('parses an invalid file again when its content changes', (context) => {
    const home = withTempDir(context);
    writeSettings(home, '{ "tui": { "theme": "bogus" } }\n');
    const cache = cacheOf(home);
    expect('error' in cache.snapshot()).toBe(true);
    writeSettings(home, '{ "autoUpdates": false           }\n');
    expect(cache.get().autoUpdates).toBe(false);
  });
});
