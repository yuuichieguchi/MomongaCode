import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const target = (jsonMode: unknown): Record<string, unknown> => ({
  adapter: 'open-responses',
  provider: 'fake',
  model: 'llama-fake',
  baseUrl: 'http://127.0.0.1:11434/v1',
  capabilities: { contextWindow: 200000, maxOutputTokens: 8192, jsonMode },
});

const load = (jsonMode: unknown) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { targets: { local: target(jsonMode) }, aliases: { default: 'local' } } });
  return { tree, loaded: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('the JSON-only mode declared in settings', () => {
  it.each(['json_object', 'none'] as const)('carries a declared %s into the target capabilities', async (jsonMode) => {
    const { loaded } = load(jsonMode);
    const { settings } = await loaded;
    expect((settings.models.targets['local'] as { capabilities?: Record<string, unknown> }).capabilities?.['jsonMode']).toBe(jsonMode);
  });

  it.each(['json', 'supported', true, 1])('validates the key: accepts json_object and rejects the declared value %j, naming the file', async (jsonMode) => {
    await expect(load('json_object').loaded).resolves.toBeDefined();
    const { tree, loaded } = load(jsonMode);
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(/jsonMode/);
  });
});
