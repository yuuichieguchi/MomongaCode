import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const targetWith = (capabilities: Record<string, unknown>) => ({
  targets: {
    remote: {
      adapter: 'chat-completions',
      provider: 'fake',
      model: 'gpt-x',
      baseUrl: 'https://api.example.com/v1',
      capabilities: { contextWindow: 4096, maxOutputTokens: 1024, ...capabilities },
    },
  },
  aliases: { default: 'remote' },
});

const load = (models: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models });
  return { tree, loading: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('capabilities.tokenErrorRatio in the settings', () => {
  it.for([0, 0.12, 1.5])('accepts %s and resolves it onto the target capabilities', async (ratio) => {
    const { loading } = load(targetWith({ tokenErrorRatio: ratio }));
    const { settings } = await loading;
    expect(settings.models.targets['remote']).toMatchObject({ capabilities: { tokenErrorRatio: ratio } });
  });

  it.for([-0.1, '0.3'])('rejects %s', async (ratio) => {
    const { tree, loading } = load(targetWith({ tokenErrorRatio: ratio }));
    await expect(loading).rejects.toThrow(userSettingsPath(tree));
  });

  it('leaves the field absent when the settings do not set it', async () => {
    const { loading } = load(targetWith({}));
    const { settings } = await loading;
    expect(settings.models.targets['remote']).not.toHaveProperty('capabilities.tokenErrorRatio');
    expect(settings.models.targets['remote']).toHaveProperty('capabilities.contextWindow', 4096);
  });
});
