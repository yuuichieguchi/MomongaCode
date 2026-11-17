import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, defaultSandboxSetting, loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

describe('sandbox setting', () => {
  it('is declared in the settings schema as seatbelt, bubblewrap or none', () => {
    const properties = SETTINGS_SCHEMA.properties as Record<string, unknown>;
    expect(properties['sandbox']).toEqual({ enum: ['seatbelt', 'bubblewrap', 'none'] });
  });

  it.each([
    ['darwin', 'seatbelt'],
    ['linux', 'bubblewrap'],
    ['win32', 'none'],
  ] as const)('defaults to %s -> %s by platform', (platform, expected) => {
    expect(defaultSandboxSetting(platform)).toBe(expected);
  });

  it('defaults to the platform sandbox for user settings', async () => {
    const tree = makeTree();
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.sandbox).toBe(defaultSandboxSetting());
  });

  it('resolves none from user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandbox: 'none' });
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.sandbox).toBe('none');
    expect(result.warnings).toEqual([]);
  });

  it('rejects an unknown sandbox value in user settings naming the pointer', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { sandbox: 'docker' });
    const failure = loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow('/sandbox');
  });

  it('defaults to the platform sandbox in loadSettings', async () => {
    const tree = makeTree();
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandbox).toBe(defaultSandboxSetting());
  });

  it('honours user settings in loadSettings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandbox: 'none' });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandbox).toBe('none');
  });

  it('drops sandbox from project settings with a warning naming the file', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { sandbox: 'none' });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandbox).toBe(defaultSandboxSetting());
    expect(result.warnings.filter((w) => w.includes(file) && w.includes('sandbox'))).toHaveLength(1);
  });

  it('drops sandbox from local settings with a warning naming the file', async () => {
    const tree = makeTree();
    const file = writeJson(localSettingsPath(tree), { sandbox: 'none' });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandbox).toBe(defaultSandboxSetting());
    expect(result.warnings.filter((w) => w.includes(file) && w.includes('sandbox'))).toHaveLength(1);
  });

  it('keeps the user value when project and local settings try to override it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { sandbox: 'none' });
    writeJson(projectSettingsPath(tree), { sandbox: 'seatbelt' });
    writeJson(localSettingsPath(tree), { sandbox: 'seatbelt' });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.sandbox).toBe('none');
    expect(result.warnings.filter((w) => w.includes('sandbox'))).toHaveLength(2);
  });
});
