import { describe, expect, it } from 'vitest';
import { createUserSettingsCache, noKeptRecords } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';

describe('user settings rule errors at load', () => {
  it('a user file with Read(a[b) loads, and the warning names the file, the key and the rule', () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(a[b)'] } });
    const warnings: string[] = [];
    const cache = createUserSettingsCache({ home: tree.home, onWarning: (message) => warnings.push(message), keptRecords: noKeptRecords });
    expect('error' in cache.snapshot()).toBe(false);
    expect(warnings.filter((warning) => warning.startsWith(`${file}: invalid settings at /permissions/deny/0: invalid permission rule "Read(a[b)": `))).toHaveLength(1);
  });

  it('a user file with valid path rules yields settings', () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(.env)', 'Read(~/.ssh/**)'] } });
    const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined, keptRecords: noKeptRecords });
    expect('error' in cache.snapshot()).toBe(false);
  });
});
