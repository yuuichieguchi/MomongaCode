import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const ollamaTarget = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'ollama',
  model: 'devstral-small-2',
  baseUrl: 'http://127.0.0.1:11434',
  capabilities: { contextWindow: 32768, maxOutputTokens: 4096 },
  ...overrides,
});

const load = (targets: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { targets, aliases: { default: Object.keys(targets)[0] } } });
  return { tree, result: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('ollama target settings', () => {
  it('accepts adapter ollama and resolves it with the declared contextWindow', async () => {
    const { result } = load({ local: ollamaTarget() });
    const { settings } = await result;
    expect(settings.models.targets['local']).toMatchObject({
      adapter: 'ollama',
      model: 'devstral-small-2',
      baseUrl: 'http://127.0.0.1:11434',
      capabilities: { contextWindow: 32768, maxOutputTokens: 4096 },
    });
  });

  it('rejects an ollama target without capabilities.contextWindow', async () => {
    const { tree, result } = load({ local: ollamaTarget({ capabilities: { maxOutputTokens: 4096 } }) });
    await expect(result).rejects.toThrow(userSettingsPath(tree));
    await expect(result).rejects.toThrow(/contextWindow/);
  });

  it('rejects an ollama target without capabilities.maxOutputTokens', async () => {
    const { tree, result } = load({ local: ollamaTarget({ capabilities: { contextWindow: 32768 } }) });
    await expect(result).rejects.toThrow(userSettingsPath(tree));
    await expect(result).rejects.toThrow(/maxOutputTokens/);
  });

  it('rejects an ollama target without capabilities', async () => {
    const { capabilities: _omitted, ...withoutCapabilities } = ollamaTarget();
    const { tree, result } = load({ local: withoutCapabilities });
    await expect(result).rejects.toThrow(userSettingsPath(tree));
    await expect(result).rejects.toThrow(/capabilities/);
  });

  it('rejects an ollama target without a model', async () => {
    const { model: _omitted, ...withoutModel } = ollamaTarget();
    const { tree, result } = load({ local: withoutModel });
    await expect(result).rejects.toThrow(userSettingsPath(tree));
  });
});
