import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, SETTING_UNIT_OF, loadSettings, loadUserSettings } from '@momonga/config';
import { MCP_CONNECT_TIMEOUT_LIMITS } from '@momonga/foundation';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

describe('mcp.connectTimeoutMs is one global user setting for the connect of every MCP server (host-bounds follow-ups, item 7a)', () => {
  it('has the range 1 to 3600000 and the default 30000', () => {
    expect(MCP_CONNECT_TIMEOUT_LIMITS).toEqual({ min: 1, max: 3_600_000, default: 30_000 });
    const mcp = SETTINGS_SCHEMA.properties['mcp'] as { properties: Record<string, unknown> };
    expect(mcp.properties['connectTimeoutMs']).toEqual({ type: 'integer', minimum: 1, maximum: 3_600_000, default: 30_000 });
    expect(SETTING_UNIT_OF['mcp.connectTimeoutMs']).toBe('milliseconds');
  });

  it.each([1, 30_000, 3_600_000])('accepts %d from user settings', async (value) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcp: { connectTimeoutMs: value } });
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.mcp.connectTimeoutMs).toBe(value);
  });

  it('is absent when the user sets nothing, so the connect uses its default', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {});
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.mcp.connectTimeoutMs).toBeUndefined();
  });

  it.each([0, -1, 3_600_001, 1.5, '30000', null, true])('refuses %o with the English message', async (value) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcp: { connectTimeoutMs: value } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow(
      `${userSettingsPath(tree)}: invalid settings at /mcp/connectTimeoutMs: must be an integer from 1 to 3600000 milliseconds; got ${JSON.stringify(value)}`,
    );
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('is discarded from %s settings with a warning', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcp: { connectTimeoutMs: 45_000 } });
    const file = writeJson(locate(tree), { mcp: { connectTimeoutMs: 1 } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.warnings).toContain(`${file}: mcp.connectTimeoutMs is only honored in user settings; discarded`);
    expect(result.settings.mcp.connectTimeoutMs).toBe(45_000);
  });
});
