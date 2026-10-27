import { describe, expect, it } from 'vitest';
import { ConfigError, createUserSettingsCache } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';

describe('user settings rule errors at load', () => {
  it('a user file with Read(a[b) yields an error snapshot naming the file', () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(a[b)'] } });
    const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined });
    const snapshot = cache.snapshot();
    expect('error' in snapshot).toBe(true);
    const { error } = snapshot as { error: ConfigError };
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message.startsWith(`${file}: invalid permission rule "Read(a[b)": `)).toBe(true);
  });

  it('a user file with valid path rules yields settings', () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(.env)', 'Read(~/.ssh/**)'] } });
    const cache = createUserSettingsCache({ home: tree.home, onWarning: () => undefined });
    expect('error' in cache.snapshot()).toBe(false);
  });
});
