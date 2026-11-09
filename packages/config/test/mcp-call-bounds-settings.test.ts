import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const load = (mcp: Record<string, unknown> | undefined) => {
  const tree = makeTree();
  if (mcp !== undefined) writeJson(userSettingsPath(tree), { mcp });
  return { tree, loaded: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('G2: mcp.toolIdleTimeoutMs and mcp.toolTotalTimeoutMs, one global setting each (decision 8)', () => {
  it('leave both unset when nothing declares them, so each transport keeps its own default', async () => {
    const { settings } = await load(undefined).loaded;
    expect(settings.mcp).toEqual({});
  });

  it('keep declared values, and 0 for the idle window', async () => {
    expect((await load({ toolIdleTimeoutMs: 600_000, toolTotalTimeoutMs: 3_600_000 }).loaded).settings.mcp).toEqual({ toolIdleTimeoutMs: 600_000, toolTotalTimeoutMs: 3_600_000 });
    expect((await load({ toolIdleTimeoutMs: 0 }).loaded).settings.mcp).toEqual({ toolIdleTimeoutMs: 0 });
  });

  it.for([
    { key: 'toolIdleTimeoutMs', value: -1 },
    { key: 'toolIdleTimeoutMs', value: 1.5 },
    { key: 'toolTotalTimeoutMs', value: 0 },
    { key: 'toolTotalTimeoutMs', value: '100800000' },
  ])('refuse $key = $value, naming the key: the overall limit is never off', async ({ key, value }) => {
    const { tree, loaded } = load({ [key]: value });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(key);
  });

  it.for([{ key: 'toolIdleTimeoutMs' }, { key: 'toolTotalTimeoutMs' }])('discards mcp.$key from project settings with a warning naming the file', async ({ key }) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcp: { [key]: 1234 } });
    const file = writeJson(projectSettingsPath(tree), { mcp: { [key]: 9 } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.mcp).toEqual({ [key]: 1234 });
    expect(result.warnings.some((warning) => warning.includes(`mcp.${key} is only honored in user settings`) && warning.includes(file))).toBe(true);
  });
});
