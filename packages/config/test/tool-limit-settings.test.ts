import { describe, expect, it } from 'vitest';
import { DEFAULT_BASH_DRAIN_IDLE_MS, loadSettings, loadUserSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const userResolved = async (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return (await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings;
};

const userRejected = async (settings: Record<string, unknown>, fragment: RegExp): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow(fragment);
};

describe('the time limits of the tools are settings', () => {
  it('default to the values of the host-bounds design', async () => {
    const { tools, update } = await userResolved({});
    expect(tools.bash).toEqual({ defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000, onTimeout: 'background', backgroundTimeoutMs: 1_800_000, maxBackgroundTimeoutMs: 7_200_000, drainIdleMs: DEFAULT_BASH_DRAIN_IDLE_MS });
    expect(tools.search).toEqual({ timeoutMs: 60_000 });
    expect(tools.operations).toEqual({ timeoutMs: 120_000 });
    expect(update).toEqual({ stallTimeoutMs: 30_000 });
  });

  it('take the values the person sets, each key by itself', async () => {
    const { tools, update } = await userResolved({ tools: { bash: { maxTimeoutMs: 900_000, onTimeout: 'kill' }, search: { timeoutMs: 20_000 }, operations: { timeoutMs: 45_000 } }, update: { stallTimeoutMs: 90_000 } });
    expect(tools.bash).toEqual({ defaultTimeoutMs: 120_000, maxTimeoutMs: 900_000, onTimeout: 'kill', backgroundTimeoutMs: 1_800_000, maxBackgroundTimeoutMs: 7_200_000, drainIdleMs: DEFAULT_BASH_DRAIN_IDLE_MS });
    expect(tools.search.timeoutMs).toBe(20_000);
    expect(tools.operations.timeoutMs).toBe(45_000);
    expect(update.stallTimeoutMs).toBe(90_000);
  });

  it('merges a project layer over the user layer key by key', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { tools: { bash: { defaultTimeoutMs: 30_000 } } });
    writeJson(projectSettingsPath(tree), { tools: { bash: { onTimeout: 'kill' } } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.tools.bash).toMatchObject({ defaultTimeoutMs: 30_000, onTimeout: 'kill', maxTimeoutMs: 600_000 });
  });

  it.each([
    ['an unknown onTimeout', { tools: { bash: { onTimeout: 'ignore' } } }, /tools\/bash\/onTimeout/],
    ['a zero search limit', { tools: { search: { timeoutMs: 0 } } }, /tools\/search\/timeoutMs/],
    ['a fractional operation limit', { tools: { operations: { timeoutMs: 1.5 } } }, /tools\/operations\/timeoutMs/],
    ['an unknown bash key', { tools: { bash: { timeout: 5 } } }, /tools\/bash/],
    ['a zero stall limit', { update: { stallTimeoutMs: 0 } }, /update\/stallTimeoutMs/],
  ])('rejects %s', async (_label, settings, fragment) => {
    await userRejected(settings, fragment);
  });

});
