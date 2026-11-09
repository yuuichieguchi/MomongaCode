import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const userResolved = async (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return (await loadUserSettings({ home: tree.home })).settings;
};

const userRejected = async (settings: Record<string, unknown>, fragment: string | RegExp): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  await expect(loadUserSettings({ home: tree.home })).rejects.toThrow(fragment);
};

const ABSOLUTE = path.join(path.sep, 'opt', 'tools', 'rg');

describe('tools.ripgrep', () => {
  it('defaults to "bundled"', async () => {
    expect((await userResolved({})).tools.ripgrep).toBe('bundled');
  });

  it('is described by the settings schema', () => {
    const tools = SETTINGS_SCHEMA.properties['tools'] as { properties: Record<string, unknown> };
    expect(Object.keys(tools.properties)).toContain('ripgrep');
  });

  it.each(['bundled', 'system', ABSOLUTE])('accepts %s from user settings', async (value) => {
    expect((await userResolved({ tools: { ripgrep: value } })).tools.ripgrep).toBe(value);
  });

  it('keeps the other tools settings beside it', async () => {
    expect((await userResolved({ tools: { ripgrep: 'system', deferral: true } })).tools).toEqual({ deferral: true, conciseDescriptions: false, ripgrep: 'system' });
  });

  it.each([['a relative path', 'bin/rg'], ['an empty string', ''], ['a number', 7], ['a boolean', true]])('rejects %s', async (_label, value) => {
    await userRejected({ tools: { ripgrep: value } }, /tools\.ripgrep/);
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('discards tools.ripgrep from %s settings with a warning and never selects an executable from it', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tools: { ripgrep: 'system' } });
    const file = writeJson(locate(tree), { tools: { ripgrep: ABSOLUTE, deferral: true } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.tools.ripgrep).toBe('system');
    expect(result.settings.tools.deferral).toBe(true);
    expect(result.warnings).toContain(`${file}: tools.ripgrep is only honored in user settings; discarded`);
  });

  it('keeps the default when only a project file sets it', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { tools: { ripgrep: ABSOLUTE } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.tools.ripgrep).toBe('bundled');
  });
});
