import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };

const target = (adapter: 'chat-completions' | 'open-responses', capabilities: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter,
  provider: 'fake',
  model: 'gpt-x',
  baseUrl: 'https://api.example.com/v1',
  capabilities: { ...CAPABILITIES, ...capabilities },
});

const load = (targets: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { targets, aliases: { default: Object.keys(targets)[0] } } });
  return { tree, loaded: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const promptCacheOf = async (targets: Record<string, unknown>, name: string): Promise<unknown> => {
  const { settings } = await load(targets).loaded;
  const resolved = settings.models.targets[name];
  return resolved !== undefined && 'capabilities' in resolved ? (resolved.capabilities as { promptCache?: unknown }).promptCache : undefined;
};

describe('a person declares the key prompt cache of a target, which no probe can observe', () => {
  it.for(['chat-completions', 'open-responses'] as const)('resolves a declared key on a %s target', async (adapter) => {
    expect(await promptCacheOf({ remote: target(adapter, { promptCache: { kind: 'key' } }) }, 'remote')).toEqual({ kind: 'key' });
  });

  it.for(['chat-completions', 'open-responses'] as const)('leaves the capability absent on a %s target that declares none, so nothing is sent', async (adapter) => {
    const { settings } = await load({ remote: target(adapter) }).loaded;
    const resolved = settings.models.targets['remote'];
    expect(resolved !== undefined && 'capabilities' in resolved ? resolved.capabilities : {}).not.toHaveProperty('promptCache');
  });

  it('resolves declared automatic and none', async () => {
    expect(await promptCacheOf({ remote: target('chat-completions', { promptCache: { kind: 'automatic' } }) }, 'remote')).toEqual({ kind: 'automatic' });
    expect(await promptCacheOf({ remote: target('chat-completions', { promptCache: { kind: 'none' } }) }, 'remote')).toEqual({ kind: 'none' });
  });

  const invalid: Array<{ name: string; promptCache: unknown }> = [
    { name: 'an unknown kind', promptCache: { kind: 'session' } },
    { name: 'breakpoints without a maximum', promptCache: { kind: 'breakpoints' } },
    { name: 'breakpoints with a maximum of zero', promptCache: { kind: 'breakpoints', maxBreakpoints: 0 } },
    { name: 'a key with an extra field', promptCache: { kind: 'key', value: 'k' } },
    { name: 'a bare string', promptCache: 'key' },
  ];

  it.for(invalid)('refuses $name, naming the settings file', async ({ promptCache }) => {
    const { tree, loaded } = load({ remote: target('chat-completions', { promptCache }) });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(/promptCache/);
  });
});
