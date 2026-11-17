import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

describe('a timeout setting is a positive integer', () => {
  it.for(['headersTimeoutMs', 'idleTimeoutMs'])('refuses models.%s: 0 with the setting path in the message', async (key) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { [key]: 0 } });
    const loaded = loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(`/models/${key}`);
  });

  it('accepts 1 for each bound', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { headersTimeoutMs: 1, idleTimeoutMs: 1 } });
    const { settings } = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.models).toMatchObject({ headersTimeoutMs: 1, idleTimeoutMs: 1 });
  });
});
