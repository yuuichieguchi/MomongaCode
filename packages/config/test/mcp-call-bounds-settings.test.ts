import { describe, expect, it } from 'vitest';
import { loadSettings, SETTINGS_SCHEMA } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const load = (mcp: Record<string, unknown> | undefined) => {
  const tree = makeTree();
  if (mcp !== undefined) writeJson(userSettingsPath(tree), { mcp });
  return { tree, loaded: loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const KEYS = ['toolIdleTimeoutNetworkMs', 'toolIdleTimeoutStdioMs', 'toolTotalTimeoutMs'] as const;

describe('the MCP call bounds: an idle key per transport and one total key', () => {
  it('declares the three keys and no other call bound', () => {
    const mcp = (SETTINGS_SCHEMA.properties as unknown as Record<string, { properties: Record<string, unknown> }>)['mcp'] as { properties: Record<string, unknown> };
    expect(Object.keys(mcp.properties).filter((key) => key.startsWith('tool')).sort()).toEqual([...KEYS].sort());
  });

  it('leaves every key unset when nothing declares it, so each transport keeps its own default', async () => {
    expect((await load(undefined).loaded).settings.mcp).toEqual({});
  });

  it('keeps declared values, and 0 for an idle window', async () => {
    const declared = { toolIdleTimeoutNetworkMs: 600_000, toolIdleTimeoutStdioMs: 900_000, toolTotalTimeoutMs: 3_600_000 };
    expect((await load(declared).loaded).settings.mcp).toEqual(declared);
    expect((await load({ toolIdleTimeoutStdioMs: 0, toolIdleTimeoutNetworkMs: 0 }).loaded).settings.mcp).toEqual({ toolIdleTimeoutStdioMs: 0, toolIdleTimeoutNetworkMs: 0 });
  });

  it.for([
    { key: 'toolIdleTimeoutNetworkMs', value: -1 },
    { key: 'toolIdleTimeoutStdioMs', value: 1.5 },
    { key: 'toolTotalTimeoutMs', value: 0 },
    { key: 'toolTotalTimeoutMs', value: '100000000' },
  ])('refuses $key = $value, naming the key: the overall limit is never off', async ({ key, value }) => {
    const { tree, loaded } = load({ [key]: value });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(key);
  });

  it('refuses the retired mcp.toolIdleTimeoutMs and names both idle keys', async () => {
    const { loaded } = load({ toolIdleTimeoutMs: 600_000 });
    await expect(loaded).rejects.toThrow(/invalid settings at \/mcp\/toolIdleTimeoutMs: is not a setting any more; .*mcp\.toolIdleTimeoutNetworkMs.*mcp\.toolIdleTimeoutStdioMs/);
  });

  it.for(KEYS.map((key) => ({ key })))('discards mcp.$key from project settings with a warning naming the file', async ({ key }) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcp: { [key]: 1234 } });
    const file = writeJson(projectSettingsPath(tree), { mcp: { [key]: 9 } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.mcp).toEqual({ [key]: 1234 });
    expect(result.warnings.some((warning) => warning.includes(`mcp.${key} is only honored in user settings`) && warning.includes(file))).toBe(true);
  });
});
