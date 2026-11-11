import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, TUI_NOTIFY_MODES, TUI_THEMES, loadSettings, loadUserSettings, writeTuiSetting } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';
const UNABORTED = { lock: testKernelLock(), signal: new AbortController().signal };


const userTui = async (tui: Record<string, unknown> | undefined) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), tui === undefined ? {} : { tui });
  return (await loadUserSettings({ home: tree.home, signal: new AbortController().signal })).settings.tui;
};

const A11Y_OFF = { screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true };

describe('tui.theme and tui.notify', () => {
  it('name the five sets and the two notification values', () => {
    expect(TUI_THEMES).toEqual(['auto', 'dark', 'light', 'dark-colorblind', 'light-colorblind']);
    expect(TUI_NOTIFY_MODES).toEqual(['off', 'bell']);
  });

  it('default to auto and off', async () => {
    expect(await userTui(undefined)).toEqual({ theme: 'auto', notify: 'off', ...A11Y_OFF });
  });

  it('are described by the settings schema under one tui object', () => {
    const tui = SETTINGS_SCHEMA.properties['tui'] as { properties: Record<string, unknown> };
    expect(Object.keys(tui.properties).sort()).toEqual(['attachFileMentions', 'copyOnSelect', 'mouse', 'notify', 'reducedMotion', 'screen', 'screenReader', 'theme']);
  });

  it.each(TUI_THEMES)('accepts the theme %s', async (theme) => {
    expect(await userTui({ theme })).toEqual({ theme, notify: 'off', ...A11Y_OFF });
  });

  it('accepts bell and keeps the default of the key that is not set', async () => {
    expect(await userTui({ notify: 'bell' })).toEqual({ theme: 'auto', notify: 'bell', ...A11Y_OFF });
  });

  it.each(['solarized', '', 'Dark', 7, null])('refuses the theme %o with the list of the five ids', async (theme) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { theme } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow(`${userSettingsPath(tree)}: invalid settings at /tui/theme: must be one of auto, dark, light, dark-colorblind, light-colorblind; got ${JSON.stringify(theme)}`);
  });

  it.each(['osc9', true])('refuses the notification value %o with the list of the two', async (notify) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { notify } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow(`${userSettingsPath(tree)}: invalid settings at /tui/notify: must be one of off, bell; got ${JSON.stringify(notify)}`);
  });

  it('refuses a key the tui object does not have', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { themes: 'dark' } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow('/tui/themes');
  });

  it('lets a project layer set a key over the user layer, key by key', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { theme: 'dark', notify: 'bell' } });
    writeJson(projectSettingsPath(tree), { tui: { theme: 'light-colorblind' } });
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.tui).toEqual({ theme: 'light-colorblind', notify: 'bell', ...A11Y_OFF });
  });
});

describe('writeTuiSetting', () => {
  it('writes one key into the user settings file and keeps every other key', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { autoUpdates: false, tui: { notify: 'bell' } });
    await writeTuiSetting(tree.home, file, 'theme', 'dark-colorblind', UNABORTED);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ autoUpdates: false, tui: { notify: 'bell', theme: 'dark-colorblind' } });
    expect((await loadUserSettings({ home: tree.home, signal: new AbortController().signal })).settings.tui).toEqual({ theme: 'dark-colorblind', notify: 'bell', ...A11Y_OFF });
  });

  it('creates the file when there is none', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    await writeTuiSetting(tree.home, file, 'notify', 'bell', UNABORTED);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ tui: { notify: 'bell' } });
  });

  it('refuses a tui value that is not an object and leaves the file as it is', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { tui: 'dark' });
    await expect(writeTuiSetting(tree.home, file, 'theme', 'dark', UNABORTED)).rejects.toThrow(`${file}: tui must be a JSON object`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ tui: 'dark' });
  });

  it('ends with the reason of its signal when the signal is already aborted', async () => {
    const tree = makeTree();
    const stopped = new AbortController();
    stopped.abort(new Error('the command was cancelled'));
    await expect(writeTuiSetting(tree.home, userSettingsPath(tree), 'theme', 'dark', { lock: testKernelLock(), signal: stopped.signal })).rejects.toThrow('the command was cancelled');
    expect(fs.existsSync(userSettingsPath(tree))).toBe(false);
  });
});

describe('tui.screenReader and tui.reducedMotion', () => {
  it('default to false', async () => {
    expect(await userTui(undefined)).toMatchObject(A11Y_OFF);
  });

  it.each(['screenReader', 'reducedMotion'] as const)('accepts true and false for %s and keeps the other keys', async (name) => {
    expect(await userTui({ [name]: true })).toEqual({ theme: 'auto', notify: 'off', ...A11Y_OFF, [name]: true });
    expect(await userTui({ [name]: false })).toEqual({ theme: 'auto', notify: 'off', ...A11Y_OFF });
  });

  it.each(['screenReader', 'reducedMotion'] as const)('refuses a value of %s that is not a boolean', async (name) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { [name]: 'on' } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow(`/tui/${name}`);
  });

  it('are written by writeTuiSetting beside the other keys', async () => {
    const tree = makeTree();
    const file = userSettingsPath(tree);
    writeJson(file, { tui: { theme: 'dark' } });
    await writeTuiSetting(tree.home, file, 'screenReader', true, UNABORTED);
    await writeTuiSetting(tree.home, file, 'reducedMotion', true, UNABORTED);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ tui: { theme: 'dark', screenReader: true, reducedMotion: true } });
  });
});

describe('tui.attachFileMentions', () => {
  it('is on by default and can be switched off in the settings file', async () => {
    expect((await userTui(undefined)).attachFileMentions).toBe(true);
    expect((await userTui({ attachFileMentions: false })).attachFileMentions).toBe(false);
  });

  it('refuses a value that is not a boolean', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tui: { attachFileMentions: 'no' } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow('/tui/attachFileMentions');
  });

  it('is written by the settings writer', async () => {
    const tree = makeTree();
    await writeTuiSetting(tree.home, userSettingsPath(tree), 'attachFileMentions', false, UNABORTED);
    expect((await loadUserSettings({ home: tree.home, signal: new AbortController().signal })).settings.tui.attachFileMentions).toBe(false);
  });
});
