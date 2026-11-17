import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { connectionOf, makeTree, modelOf, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 4096 };

const TARGETS: Record<string, Record<string, unknown>> = {
  'chat-completions': { adapter: 'chat-completions', provider: 'fake', model: 'gpt-x', baseUrl: 'https://api.example.com/v1', capabilities: CAPABILITIES },
  'open-responses': { adapter: 'open-responses', provider: 'fake', model: 'llama-fake', baseUrl: 'http://127.0.0.1:11434/v1', capabilities: CAPABILITIES },
  anthropic: { adapter: 'anthropic', model: 'claude-fake', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', capabilities: CAPABILITIES },
  ollama: { adapter: 'ollama', model: 'llama3', baseUrl: 'http://127.0.0.1:11434', capabilities: CAPABILITIES },
  fm: { adapter: 'managed', server: 'fm' },
};

const load = (target: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('main', target)] } });
  return { tree, loaded: loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

describe('a target declares what answers it', () => {
  it.each(Object.entries(TARGETS))('%s: answers model is accepted and resolved with the target', async (_adapter, target) => {
    const { loaded } = load({ ...target, answers: 'model' });
    expect(modelOf((await loaded).settings, 'main')).toMatchObject({ answers: 'model' });
  });

  it.each(Object.entries(TARGETS))('%s: answers script is accepted and resolved with the target', async (_adapter, target) => {
    const { loaded } = load({ ...target, answers: 'script' });
    expect(modelOf((await loaded).settings, 'main')).toMatchObject({ answers: 'script' });
  });

  it.each(Object.entries(TARGETS))('%s: another value is rejected, naming the setting', async (_adapter, target) => {
    const { tree, loaded } = load({ ...target, answers: 'human' });
    await expect(loaded).rejects.toThrow(userSettingsPath(tree));
    await expect(load({ ...target, answers: 'human' }).loaded).rejects.toThrow(/answers/);
    const accepted = await load({ ...target, answers: 'model' }).loaded;
    expect(modelOf(accepted.settings, 'main')).toMatchObject({ answers: 'model' });
  });

  it.each(Object.entries(TARGETS))('%s: an undeclared target resolves with no answers, never a default', async (_adapter, target) => {
    const { loaded } = load(target);
    const resolved = modelOf((await loaded).settings, 'main') as Record<string, unknown>;
    expect(Object.hasOwn(resolved, 'answers')).toBe(false);
    const declared = await load({ ...target, answers: 'script' }).loaded;
    expect(modelOf(declared.settings, 'main')).toMatchObject({ answers: 'script' });
  });
});
