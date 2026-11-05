import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 32768, maxOutputTokens: 4096 };

const anthropicTarget = (extra: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'anthropic',
  model: 'model-a',
  baseUrl: 'https://api.example.com',
  apiKeySecret: 'anthropic-main',
  capabilities: { ...CAPABILITIES, ...capabilities },
  ...extra,
});

const settingsWith = (target: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { targets: { remote: target }, aliases: { default: 'remote' } } });
  return { tree, loaded: loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const expectRefused = async (target: Record<string, unknown>, ...fragments: string[]): Promise<void> => {
  const { tree, loaded } = settingsWith(target);
  await expect(loaded).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(loaded).rejects.toThrow(fragment);
};

describe('the declared API version of an anthropic target', () => {
  it('resolves to 2026-10-21 when the target declares none', async () => {
    const { settings } = await settingsWith(anthropicTarget()).loaded;
    expect(settings.models.targets['remote']).toMatchObject({ apiVersion: '2026-10-21' });
  });

  it.for(['2026-10-21', '2023-06-01'])('accepts and keeps %s', async (apiVersion) => {
    const { settings } = await settingsWith(anthropicTarget({ apiVersion })).loaded;
    expect(settings.models.targets['remote']).toMatchObject({ apiVersion });
  });

  it('refuses a version outside the enum, naming apiVersion', async () => {
    await expectRefused(anthropicTarget({ apiVersion: '2024-01-01' }), 'remote', 'apiVersion');
  });

  it.for([
    { adapter: 'chat-completions', provider: 'fake', model: 'model-a', baseUrl: 'https://api.example.com/v1', capabilities: CAPABILITIES },
    { adapter: 'open-responses', provider: 'fake', model: 'model-a', baseUrl: 'https://api.example.com/v1', capabilities: CAPABILITIES },
    { adapter: 'ollama', model: 'model-a', baseUrl: 'http://127.0.0.1:11434', capabilities: CAPABILITIES },
  ])('$adapter refuses apiVersion', async (target) => {
    await expectRefused({ ...target, apiVersion: '2023-06-01' }, 'remote', 'apiVersion');
  });
});

describe('a sampling declaration that the API version can never honour is refused at load', () => {
  it.for([
    { label: 'free with the default version', extra: {}, sampling: { accepts: 'free' } },
    { label: 'without_thinking with the default version', extra: {}, sampling: { accepts: 'without_thinking', topP: { min: 0.95, max: 1 } } },
    { label: 'free with an explicit 2026-10-21', extra: { apiVersion: '2026-10-21' }, sampling: { accepts: 'free' } },
  ])('$label names sampling and apiVersion', async ({ extra, sampling }) => {
    await expectRefused(anthropicTarget(extra, { sampling }), 'remote', 'sampling', 'apiVersion');
  });

  it.for([{}, { apiVersion: '2026-10-21' }])('accepts none under 2026-10-21 (%o)', async (extra) => {
    const { settings } = await settingsWith(anthropicTarget(extra, { sampling: { accepts: 'none' } })).loaded;
    expect(settings.models.targets['remote']).toMatchObject({ apiVersion: '2026-10-21', capabilities: { sampling: { accepts: 'none' } } });
  });
});
