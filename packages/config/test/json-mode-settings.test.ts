import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { connectionOf, makeTree, modelOf, trusting, userSettingsPath, writeJson } from './helpers.ts';

const target = (jsonMode: unknown): Record<string, unknown> => ({
  adapter: 'open-responses',
  provider: 'fake',
  model: 'llama-fake',
  baseUrl: 'http://127.0.0.1:11434/v1',
  capabilities: { contextWindow: 200000, maxOutputTokens: 8192, jsonMode },
});

const load = (jsonMode: unknown) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('local', target(jsonMode))] } });
  return { tree, loaded: loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('the JSON-only mode declared in settings', () => {
  it.each(['json_object', 'none'] as const)('carries a declared %s into the target capabilities', async (jsonMode) => {
    const { loaded } = load(jsonMode);
    const { settings } = await loaded;
    expect((modelOf(settings, 'local') as { capabilities?: Record<string, unknown> }).capabilities?.['jsonMode']).toBe(jsonMode);
  });

  it.each(['json', 'supported', true, 1])('validates the key: accepts json_object and rejects the declared value %j, naming the file', async (jsonMode) => {
    await expect(load('json_object').loaded).resolves.toBeDefined();
    const { tree, loaded } = load(jsonMode);
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow(/jsonMode/);
  });
});

describe('a declared JSON-only mode on an adapter with no native form', () => {
  it('is refused at load with an English reason naming the place of the model in the file and the adapter', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      models: {
        connections: [connectionOf('claude', { adapter: 'anthropic', model: 'claude-fake', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', capabilities: { contextWindow: 200000, maxOutputTokens: 8192, jsonMode: 'json_object' } })],
      },
    });
    const loaded = loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    await expect(loaded).rejects.toThrow('models.connections[0].models[0]');
    await expect(loaded).rejects.toThrow(/anthropic/);
    await expect(loaded).rejects.toThrow(/jsonMode/);
    await expect(loaded).rejects.not.toThrow(/must NOT have additional properties/);
  });

  it('accepts a declared none on the same adapter', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      models: {
        connections: [connectionOf('claude', { adapter: 'anthropic', model: 'claude-fake', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', capabilities: { contextWindow: 200000, maxOutputTokens: 8192, jsonMode: 'none' } })],
      },
    });
    const { settings } = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect((modelOf(settings, 'claude') as { capabilities?: Record<string, unknown> }).capabilities?.['jsonMode']).toBe('none');
  });
});
