import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { connectionOf, makeTree, modelOf, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };

const anthropicTarget = (reasoning?: Record<string, unknown>): Record<string, unknown> => ({
  adapter: 'anthropic',
  model: 'model-a',
  baseUrl: 'https://api.anthropic.com',
  apiKeySecret: 'anthropic-main',
  capabilities: { ...CAPABILITIES, ...(reasoning === undefined ? {} : { reasoning }) },
});

const load = async (target: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('remote', target)] } });
  return loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
};

const expectRejected = async (target: Record<string, unknown>, ...fragments: (string | RegExp)[]): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('remote', target)] } });
  const failure = loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
  await expect(failure).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(failure).rejects.toThrow(fragment);
};

const thinkingWarningsOf = (warnings: readonly string[]): string[] => warnings.filter((warning) => warning.includes('models.connections[0].models[0]') && /thinking/i.test(warning));

describe('declared thinking form of an anthropic target', () => {
  it('accepts the adaptive form with the effort levels the target accepts', async () => {
    const reasoning = { control: 'thinking', form: 'adaptive', efforts: ['low', 'medium', 'high'] };
    const { settings } = await load(anthropicTarget(reasoning));
    expect(modelOf(settings, 'remote')).toMatchObject({ capabilities: { reasoning } });
  });

  it('accepts the budget form with a declared budget per level', async () => {
    const reasoning = { control: 'thinking', form: 'budget', budgets: { low: 1024, high: 6000 } };
    const { settings } = await load(anthropicTarget(reasoning));
    expect(modelOf(settings, 'remote')).toMatchObject({ capabilities: { reasoning } });
  });

  it('rejects the budget form without budgets', async () => {
    await expectRejected(anthropicTarget({ control: 'thinking', form: 'budget' }));
  });

  it('rejects a budget below 1024 tokens', async () => {
    await expectRejected(anthropicTarget({ control: 'thinking', form: 'budget', budgets: { low: 1000 } }));
  });

  it('rejects a budget keyed by something that is not an effort level', async () => {
    await expectRejected(anthropicTarget({ control: 'thinking', form: 'budget', budgets: { huge: 4096 } }));
  });

  it('rejects an unknown thinking form', async () => {
    await expectRejected(anthropicTarget({ control: 'thinking', form: 'guess' }));
  });

  it.for(['disabled', 'between_tools'])('accepts the off spelling %s on either form', async (off) => {
    const adaptive = { control: 'thinking', form: 'adaptive', efforts: ['low'], off };
    const budget = { control: 'thinking', form: 'budget', budgets: { low: 2048 }, off };
    expect(modelOf((await load(anthropicTarget(adaptive))).settings, 'remote')).toMatchObject({ capabilities: { reasoning: adaptive } });
    expect(modelOf((await load(anthropicTarget(budget))).settings, 'remote')).toMatchObject({ capabilities: { reasoning: budget } });
  });

  it('rejects an unknown off spelling', async () => {
    await expectRejected(anthropicTarget({ control: 'thinking', form: 'adaptive', efforts: ['low'], off: 'never' }));
  });

  it('rejects a budget that is not below the target output maximum, naming the target', async () => {
    await expectRejected(anthropicTarget({ control: 'thinking', form: 'budget', budgets: { low: 2048, high: CAPABILITIES.maxOutputTokens } }), /models[./]connections[[/]0/);
  });

  it('refuses the thinking control on an adapter that does not render it, naming the target', async () => {
    const chatCompletions = {
      adapter: 'chat-completions',
      provider: 'ollama',
      model: 'model-a',
      baseUrl: 'http://127.0.0.1:1234/v1',
      capabilities: { ...CAPABILITIES, reasoning: { control: 'thinking', form: 'adaptive', efforts: ['low'] } },
    };
    await expectRejected(chatCompletions, /models[./]connections[[/]0/);
  });

  it('a chat-completions target keeps its reasoning_effort declaration', async () => {
    const reasoning = { control: 'reasoning_effort', lowest: 'none' };
    const { settings } = await load({ adapter: 'chat-completions', provider: 'ollama', model: 'model-a', baseUrl: 'http://127.0.0.1:1234/v1', capabilities: { ...CAPABILITIES, reasoning } });
    expect(modelOf(settings, 'remote')).toMatchObject({ capabilities: { reasoning } });
  });
});

describe('an anthropic target that declares no thinking form', () => {
  it('tells the user that the target will be sent no thinking request', async () => {
    const { warnings } = await load(anthropicTarget());
    expect(thinkingWarningsOf(warnings)).toHaveLength(1);
  });

  it('says nothing about thinking once the target declares a form', async () => {
    const { warnings } = await load(anthropicTarget({ control: 'thinking', form: 'adaptive', efforts: ['low'] }));
    expect(thinkingWarningsOf(warnings)).toEqual([]);
  });

  it('says nothing about thinking when the target explicitly declares that reasoning cannot be controlled', async () => {
    const { warnings } = await load(anthropicTarget({ control: 'none' }));
    expect(thinkingWarningsOf(warnings)).toEqual([]);
  });
});
