import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, TUI_NOTIFY_MODES, TUI_THEMES, loadSettings, loadUserSettings, writeTuiSetting } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const userTui = async (tui: Record<string, unknown> | undefined) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), tui === undefined ? {} : { tui });
  return (await loadUserSettings({ home: tree.home })).settings.tui;
};

describe('tui.theme and tui.notify', () => {
  it('name the five sets and the two notification values', () => {
    expect(TUI_THEMES).toEqual(['auto', 'dark', 'light', 'dark-colorblind', 'light-colorblind']);
    expect(TUI_NOTIFY_MODES).toEqual(['off', 'bell']);
  });

  it('default to auto and off', async () => {
    expect(await userTui(undefined)).toEqual({ theme: 'auto', notify: 'off' });
  });

  it('are described by the settings schema under one tui object', () => {
    const tui = SETTINGS_SCHEMA.properties['tui'] as { properties: Record<string, unknown> };
    expect(Object.keys(tui.properties).sort()).toEqual(['notify', 'theme']);
  });

  it.each(TUI_THEMES)('accepts the theme %s', async (theme) => {
    expect(await userTui({ theme })).toEqual({ theme, notify: 'off' });
  });

  it('accepts bell and keeps the default of the key that is not set', async () => {
    expect(await userTui({ notify: 'bell' })).toEqual({ theme: 'auto', notify: 'bell' });
  });

  it.each(['solarized', '', 'Dark', 7, null])('refuses the theme %o with the list of the five ids', async (theme) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { theme } });
    await expect(loadUserSettings({ home: tree.home })).rejects.toThrow(`${userSettingsPath(tree)}: tui.theme must be one of auto, dark, light, dark-colorblind, light-colorblind; got ${JSON.stringify(theme)}`);
  });

  it.each(['osc9', true])('refuses the notification value %o with the list of the two', async (notify) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { notify } });
    await expect(loadUserSettings({ home: tree.home })).rejects.toThrow(`${userSettingsPath(tree)}: tui.notify must be one of off, bell; got ${JSON.stringify(notify)}`);
  });

  it('refuses a key the tui object does not have', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { themes: 'dark' } });
    await expect(loadUserSettings({ home: tree.home })).rejects.toThrow('/tui/themes');
  });

  it('lets a project layer set a key over the user layer, key by key', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { theme: 'dark', notify: 'bell' } });
    writeJson(projectSettingsPath(tree), { tui: { theme: 'light-colorblind' } });
    const { settings } = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.tui).toEqual({ theme: 'light-colorblind', notify: 'bell' });
  });
});

describe('writeTuiSetting', () => {
  it('writes one key into the user settings file and keeps every other key', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false, tui: { notify: 'bell' } });
    await writeTuiSetting(tree.home, file, 'theme', 'dark-colorblind');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ autoUpdates: false, tui: { notify: 'bell', theme: 'dark-colorblind' } });
    expect((await loadUserSettings({ home: tree.home })).settings.tui).toEqual({ theme: 'dark-colorblind', notify: 'bell' });
  });

  it('creates the file when there is none', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    await writeTuiSetting(tree.home, file, 'notify', 'bell');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ tui: { notify: 'bell' } });
  });

  it('refuses a tui value that is not an object and leaves the file as it is', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { tui: 'dark' });
    await expect(writeTuiSetting(tree.home, file, 'theme', 'dark')).rejects.toThrow(`${file}: tui must be a JSON object`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ tui: 'dark' });
  });

  it('ends with the reason of its signal when the signal is already aborted', async () => {
    const tree = makeTree();
    const stopped = new AbortController();
    stopped.abort(new Error('the command was cancelled'));
    await expect(writeTuiSetting(tree.home, userSettingsPath(tree), 'theme', 'dark', { signal: stopped.signal })).rejects.toThrow('the command was cancelled');
    expect(fs.existsSync(userSettingsPath(tree))).toBe(false);
  });
});
