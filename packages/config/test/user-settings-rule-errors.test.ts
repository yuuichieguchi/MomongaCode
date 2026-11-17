import { describe, expect, it } from 'vitest';
import { ConfigError, createUserSettingsCache, noKeptRecords } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';

const NOT_ABORTED = new AbortController().signal;

describe('user settings rule errors at load', () => {
  it('a user file with the deny rule Read(a[b) yields an error snapshot naming the file, the key and the rule', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(a[b)'] } });
    const cache = createUserSettingsCache({ env: process.env, home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
    const snapshot = await cache.load(NOT_ABORTED);
    expect('error' in snapshot).toBe(true);
    const { error } = snapshot as { error: ConfigError };
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message.startsWith(`${file}: invalid settings at /permissions/deny/0: invalid permission rule "Read(a[b)": `)).toBe(true);
  });

  it('a user file with the allow rule Read(a[b) loads, and the warning names the file, the key and the rule', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: ['Read(a[b)'] } });
    const warnings: string[] = [];
    const cache = createUserSettingsCache({ env: process.env, home: tree.home, onWarning: (message) => warnings.push(message), keptRecords: noKeptRecords });
    expect('error' in (await cache.load(NOT_ABORTED))).toBe(false);
    expect(warnings.filter((warning) => warning.startsWith(`${file}: invalid settings at /permissions/allow/0: invalid permission rule "Read(a[b)": `))).toHaveLength(1);
  });

  it('a user file with valid path rules yields settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(.env)', 'Read(~/.ssh/**)'] } });
    const cache = createUserSettingsCache({ env: process.env, home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
    expect('error' in (await cache.load(NOT_ABORTED))).toBe(false);
  });
});
