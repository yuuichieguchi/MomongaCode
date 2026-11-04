import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 4096 };

const load = (models: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models });
  return { tree, loaded: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const chat = (capabilities: Record<string, unknown>) => ({
  adapter: 'chat-completions',
  provider: 'fake',
  model: 'm',
  baseUrl: 'https://api.example.com/v1',
  capabilities,
});

describe('the outputBoundField setting', () => {
  it.each(['max_tokens', 'max_completion_tokens'])('is kept on a chat-completions target as %s', async (field) => {
    const { loaded } = load({ targets: { remote: chat({ ...CAPABILITIES, outputBoundField: field }) }, aliases: { default: 'remote' } });
    expect((await loaded).settings.models.targets['remote']).toMatchObject({ capabilities: { outputBoundField: field } });
  });

  it('is kept on an fm target', async () => {
    const { loaded } = load({ targets: { local: { adapter: 'fm', outputBoundField: 'max_tokens' } }, aliases: { default: 'local' } });
    expect((await loaded).settings.models.targets['local']).toMatchObject({ outputBoundField: 'max_tokens' });
  });

  it('is refused with another value, naming the file and the field', async () => {
    const { tree, loaded } = load({ targets: { remote: chat({ ...CAPABILITIES, outputBoundField: 'max_output_tokens' }) }, aliases: { default: 'remote' } });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow('outputBoundField');
  });

  it.each([
    ['ollama', { adapter: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:11434', capabilities: { ...CAPABILITIES, outputBoundField: 'max_tokens' } }],
    ['anthropic', { adapter: 'anthropic', model: 'm', apiKeyEnv: 'KEY', capabilities: { ...CAPABILITIES, outputBoundField: 'max_tokens' } }],
    ['open-responses', { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'https://api.example.com/v1', capabilities: { ...CAPABILITIES, outputBoundField: 'max_tokens' } }],
  ])('is refused on a %s target, naming the file and the field', async (_adapter, target) => {
    const { tree, loaded } = load({ targets: { remote: target }, aliases: { default: 'remote' } });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(loaded).rejects.toThrow('outputBoundField');
  });
});
