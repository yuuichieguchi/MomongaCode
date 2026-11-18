import { describe, expect, it } from 'vitest';
import { STARTUP_TIMEOUT_MS } from '@momonga/foundation';
import { loadUserSettings, readUserStartupStallMsOrDefault } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';

const homeWith = (settings: unknown): string => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return tree.home;
};

const signal = (): AbortSignal => new AbortController().signal;

describe('the start-up stall limit of a daemon child is the setting daemon.startupStallMs', () => {
  it('defaults to STARTUP_TIMEOUT_MS', async () => {
    const { settings } = await loadUserSettings({ env: process.env, home: homeWith({}), signal: signal() });
    expect(settings.daemon.startupStallMs).toBe(STARTUP_TIMEOUT_MS);
  });

  it('takes the value the person set', async () => {
    expect(await readUserStartupStallMsOrDefault({ env: process.env, home: homeWith({ daemon: { startupStallMs: 240_000 } }), signal: signal(), onNotice: () => undefined })).toBe(240_000);
  });

  it.each([0, -1, 1.5, '60000'])('refuses %j', async (value) => {
    await expect(loadUserSettings({ env: process.env, home: homeWith({ daemon: { startupStallMs: value } }), signal: signal() })).rejects.toThrow('/daemon/startupStallMs');
  });

  it('a settings file that cannot be read gives the default with a notice, as the stop values do', async () => {
    const notices: string[] = [];
    expect(await readUserStartupStallMsOrDefault({ env: process.env, home: homeWith({ daemon: { startupStallMs: 0 } }), signal: signal(), onNotice: (message) => notices.push(message) })).toBe(STARTUP_TIMEOUT_MS);
    expect(notices).toEqual([expect.stringMatching(/^the start-up stall limit could not be read from the user settings \(.*\); the default value was used$/)]);
  });
});
