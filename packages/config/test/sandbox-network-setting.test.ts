import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

describe('sandboxNetwork setting', () => {
  it('is declared in the settings schema as deny, ask or allow', () => {
    const properties = SETTINGS_SCHEMA.properties as Record<string, unknown>;
    expect(properties['sandboxNetwork']).toEqual({ enum: ['deny', 'ask', 'allow'] });
  });

  it('defaults to ask', async () => {
    const tree = makeTree();
    expect((await loadUserSettings({ home: tree.home })).settings.sandboxNetwork).toBe('ask');
    expect((await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).settings.sandboxNetwork).toBe('ask');
  });

  it.each(['deny', 'ask', 'allow'] as const)('is honoured from user settings: %s', async (value) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandboxNetwork: value });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandboxNetwork).toBe(value);
    expect(result.warnings).toEqual([]);
  });

  it('is honoured from the command line over user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandboxNetwork: 'allow' });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: { sandboxNetwork: 'deny' }, trust: trusting(tree) });
    expect(result.settings.sandboxNetwork).toBe('deny');
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('never reaches the effective settings from %s settings (I4.4)', async (_name, fileOf) => {
    const tree = makeTree();
    const file = writeJson(fileOf(tree), { sandboxNetwork: 'allow' });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandboxNetwork).toBe('ask');
    expect(result.warnings).toEqual([`${file}: sandboxNetwork is only honored in user settings and on the command line; discarded`]);
  });

  it('refuses an unknown value naming the pointer', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { sandboxNetwork: 'open' });
    const failure = loadUserSettings({ home: tree.home });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow('/sandboxNetwork');
  });
});
