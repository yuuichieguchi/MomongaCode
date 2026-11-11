import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, loadSettings, loadUserSettings, readUserStopValues } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const stopValuesOf = (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return readUserStopValues(tree.home, new AbortController().signal);
};

describe('runtime.drainTimeoutMs and mcp.closeGraceMs are user settings read as stop values', () => {
  it('default to 30000 and 1000, beside the two gateway defaults', async () => {
    expect(await stopValuesOf({})).toEqual({ closeGraceMs: 10_000, managedServerStopGraceMs: 3000, drainTimeoutMs: 30_000, mcpCloseGraceMs: 1000 });
  });

  it('are described by the settings schema: a new runtime object, and closeGraceMs inside the existing mcp object', async () => {
    const runtime = SETTINGS_SCHEMA.properties['runtime'] as { properties: Record<string, unknown>; additionalProperties: unknown };
    expect(Object.keys(runtime.properties)).toEqual(['drainTimeoutMs']);
    expect(runtime.additionalProperties).toBe(false);
    const mcp = SETTINGS_SCHEMA.properties['mcp'] as { properties: Record<string, unknown> };
    expect(Object.keys(mcp.properties).sort()).toEqual(['closeGraceMs', 'connectTimeoutMs', 'toolIdleTimeoutNetworkMs', 'toolIdleTimeoutStdioMs', 'toolTotalTimeoutMs']);
  });

  it.each([
    [{ runtime: { drainTimeoutMs: 0 }, mcp: { closeGraceMs: 0 } }, 0, 0],
    [{ runtime: { drainTimeoutMs: 300_000 }, mcp: { closeGraceMs: 30_000 } }, 300_000, 30_000],
    [{ runtime: { drainTimeoutMs: 1234 }, mcp: { closeGraceMs: 567, toolIdleTimeoutStdioMs: 10 } }, 1234, 567],
  ])('accepts %o from user settings', async (settings, drain, grace) => {
    expect(await stopValuesOf(settings)).toEqual({ closeGraceMs: 10_000, managedServerStopGraceMs: 3000, drainTimeoutMs: drain, mcpCloseGraceMs: grace });
  });

  it('assembles the four values from gateway, runtime and mcp, and keeps the default of a key that is not set', async () => {
    expect(await stopValuesOf({ gateway: { closeGraceMs: 5 }, runtime: { drainTimeoutMs: 6 } })).toEqual({ closeGraceMs: 5, managedServerStopGraceMs: 3000, drainTimeoutMs: 6, mcpCloseGraceMs: 1000 });
    expect(await stopValuesOf({ gateway: { managedServerStopGraceMs: 7 }, mcp: { closeGraceMs: 8 } })).toEqual({ closeGraceMs: 10_000, managedServerStopGraceMs: 7, drainTimeoutMs: 30_000, mcpCloseGraceMs: 8 });
  });

  it.each([
    ['runtime', 'drainTimeoutMs', 300000, -1],
    ['runtime', 'drainTimeoutMs', 300000, 300_001],
    ['runtime', 'drainTimeoutMs', 300000, 1.5],
    ['runtime', 'drainTimeoutMs', 300000, '30000'],
    ['runtime', 'drainTimeoutMs', 300000, null],
    ['mcp', 'closeGraceMs', 30000, -1],
    ['mcp', 'closeGraceMs', 30000, 30_001],
    ['mcp', 'closeGraceMs', 30000, 0.5],
    ['mcp', 'closeGraceMs', 30000, true],
  ])('refuses %s.%s up to %d given %o with the English message', async (object, key, max, value) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { [object]: { [key]: value } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow(
      `${userSettingsPath(tree)}: invalid settings at /${object}/${key}: must be an integer from 0 to ${max} milliseconds; got ${JSON.stringify(value)}`,
    );
  });

  it('refuses a key under runtime that is not drainTimeoutMs', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { runtime: { drainTimeoutMs: 1, workerCount: 2 } });
    await expect(loadUserSettings({ home: tree.home, signal: new AbortController().signal })).rejects.toThrow(userSettingsPath(tree));
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('discards runtime and mcp from %s settings with a warning and keeps the user values', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { runtime: { drainTimeoutMs: 4000 }, mcp: { closeGraceMs: 200 } });
    const file = writeJson(locate(tree), { runtime: { drainTimeoutMs: 0 }, mcp: { closeGraceMs: 0 } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.warnings).toContain(`${file}: runtime is only honored in user settings; discarded`);
    expect(result.warnings).toContain(`${file}: mcp.closeGraceMs is only honored in user settings; discarded`);
    expect((result.settings as unknown as { runtime: unknown }).runtime).toEqual({ drainTimeoutMs: 4000 });
    expect(await readUserStopValues(tree.home, new AbortController().signal)).toEqual({ closeGraceMs: 10_000, managedServerStopGraceMs: 3000, drainTimeoutMs: 4000, mcpCloseGraceMs: 200 });
  });
});
