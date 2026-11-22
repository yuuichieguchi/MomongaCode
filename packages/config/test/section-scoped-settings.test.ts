import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, STARTUP_TIMEOUT_MS } from '@momonga/foundation';
import {
  ConfigError,
  DEFAULT_UPDATE_STALL_TIMEOUT_MS,
  createUserSettingsCache,
  noKeptRecords,
  readUserAutoUpdates,
  readUserStartupStallMsOrDefault,
  readUserStopValues,
  readUserStopValuesOrDefault,
  readUserUpdateSettings,
} from '@momonga/config';
import { makeTree, userSettingsPath, writeJson, writeText } from './helpers.ts';

const signal = (): AbortSignal => new AbortController().signal;

const homeWith = (settings: unknown): string => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return tree.home;
};

const UNKNOWN_PLAN_MODELS = {
  connections: [{ adapter: 'open-responses', model: 'future-1', plan: { profile: 'future-plan' } }],
};

describe('section-scoped user settings readers ignore unrelated invalid sections', () => {
  describe('readUserAutoUpdates', () => {
    it('returns true when settings.json is absent or omits autoUpdates', async () => {
      const empty = makeTree();
      expect(await readUserAutoUpdates({ home: empty.home, env: process.env, signal: signal() })).toBe(true);
      expect(await readUserAutoUpdates({ home: homeWith({}), env: process.env, signal: signal() })).toBe(true);
    });

    it('reads autoUpdates even when models has an unknown plan profile or unrelated sections are invalid', async () => {
      expect(await readUserAutoUpdates({ home: homeWith({ models: UNKNOWN_PLAN_MODELS }), env: process.env, signal: signal() })).toBe(true);
      expect(await readUserAutoUpdates({ home: homeWith({ models: UNKNOWN_PLAN_MODELS, autoUpdates: true }), env: process.env, signal: signal() })).toBe(true);
      expect(await readUserAutoUpdates({ home: homeWith({ models: UNKNOWN_PLAN_MODELS, autoUpdates: false }), env: process.env, signal: signal() })).toBe(false);
      expect(await readUserAutoUpdates({ home: homeWith({ hooks: 'not-an-object', mcp: { connectTimeoutMs: 0 } }), env: process.env, signal: signal() })).toBe(true);
    });

    it('rejects an invalid autoUpdates value, non-object JSON, or broken JSON', async () => {
      await expect(readUserAutoUpdates({ home: homeWith({ models: UNKNOWN_PLAN_MODELS, autoUpdates: 'false' }), env: process.env, signal: signal() })).rejects.toThrow('/autoUpdates');
      await expect(readUserAutoUpdates({ home: homeWith([]), env: process.env, signal: signal() })).rejects.toThrow(ConfigError);
      const broken = makeTree();
      writeText(userSettingsPath(broken), '{ not json');
      await expect(readUserAutoUpdates({ home: broken.home, env: process.env, signal: signal() })).rejects.toThrow(ConfigError);
    });
  });

  describe('readUserUpdateSettings', () => {
    it('reads update.stallTimeoutMs despite an unknown plan profile in models', async () => {
      expect(await readUserUpdateSettings({ home: homeWith({ models: UNKNOWN_PLAN_MODELS }), env: process.env, signal: signal() })).toEqual({
        stallTimeoutMs: DEFAULT_UPDATE_STALL_TIMEOUT_MS,
      });
      expect(await readUserUpdateSettings({ home: homeWith({ models: UNKNOWN_PLAN_MODELS, update: { stallTimeoutMs: 5_000 } }), env: process.env, signal: signal() })).toEqual({
        stallTimeoutMs: 5_000,
      });
    });

    it('still rejects an invalid update.stallTimeoutMs', async () => {
      await expect(readUserUpdateSettings({ home: homeWith({ models: UNKNOWN_PLAN_MODELS, update: { stallTimeoutMs: 0 } }), env: process.env, signal: signal() })).rejects.toThrow('/update/stallTimeoutMs');
    });
  });

  describe('readUserStartupStallMsOrDefault', () => {
    it('reads daemon.startupStallMs without notice when models has an unknown plan profile', async () => {
      const notices: string[] = [];
      expect(
        await readUserStartupStallMsOrDefault({
          home: homeWith({ models: UNKNOWN_PLAN_MODELS, daemon: { startupStallMs: 240_000 } }),
          env: process.env,
          signal: signal(),
          onNotice: (message) => notices.push(message),
        }),
      ).toBe(240_000);
      expect(
        await readUserStartupStallMsOrDefault({
          home: homeWith({ models: UNKNOWN_PLAN_MODELS }),
          env: process.env,
          signal: signal(),
          onNotice: (message) => notices.push(message),
        }),
      ).toBe(STARTUP_TIMEOUT_MS);
      expect(notices).toEqual([]);
    });
  });

  describe('readUserStopValues and readUserStopValuesOrDefault', () => {
    it('reads stop values without notice when models or unrelated mcp fields are invalid', async () => {
      const notices: string[] = [];
      const home = homeWith({
        models: UNKNOWN_PLAN_MODELS,
        gateway: { closeGraceMs: 10_000, managedServerStopGraceMs: 3_000 },
        runtime: { drainTimeoutMs: 4_000 },
        mcp: { closeGraceMs: 200, connectTimeoutMs: 0 },
      });
      expect(await readUserStopValuesOrDefault({ home, env: process.env, signal: signal(), onNotice: (message) => notices.push(message) })).toEqual({
        closeGraceMs: 10_000,
        managedServerStopGraceMs: 3_000,
        drainTimeoutMs: 4_000,
        mcpCloseGraceMs: 200,
      });
      expect(notices).toEqual([]);
    });

    it('still rejects an invalid mcp.closeGraceMs and emits a notice on OrDefault', async () => {
      const notices: string[] = [];
      const home = homeWith({ models: UNKNOWN_PLAN_MODELS, mcp: { closeGraceMs: -1 } });
      await expect(readUserStopValues(home, process.env, signal())).rejects.toThrow('/mcp/closeGraceMs');
      expect(await readUserStopValuesOrDefault({ home, env: process.env, signal: signal(), onNotice: (message) => notices.push(message) })).toEqual(DEFAULT_STOP_VALUES);
      expect(notices).toHaveLength(1);
    });
  });

  describe('createUserSettingsCache with sections: { network: true }', () => {
    it('loads network settings despite an unknown plan profile in models, and still rejects invalid network settings', async () => {
      const cache = createUserSettingsCache({
        home: homeWith({ models: UNKNOWN_PLAN_MODELS, network: { httpsProxy: 'http://proxy.example:8080' } }),
        env: process.env,
        onWarning: () => undefined,
        keptRecords: noKeptRecords,
        sections: { network: true },
      });
      const loaded = await cache.load(signal());
      expect('error' in loaded).toBe(false);
      if (!('error' in loaded)) expect(loaded.settings.network).toEqual({ httpsProxy: 'http://proxy.example:8080' });

      const invalid = createUserSettingsCache({
        home: homeWith({ models: UNKNOWN_PLAN_MODELS, network: { extraCaFiles: ['relative.pem'] } }),
        env: process.env,
        onWarning: () => undefined,
        keptRecords: noKeptRecords,
        sections: { network: true },
      });
      const failed = await invalid.load(signal());
      expect('error' in failed && failed.error.message).toContain('/network/extraCaFiles/0');
    });
  });
});
