import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

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
  writeJson(userSettingsPath(tree), { models: { targets: { remote: target }, aliases: { default: 'remote' } } });
  return loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
};

const expectRejected = async (target: Record<string, unknown>): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { targets: { remote: target } } });
  await expect(loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow(userSettingsPath(tree));
};

const thinkingWarningsOf = (warnings: readonly string[]): string[] => warnings.filter((warning) => warning.includes('remote') && /thinking/i.test(warning));

describe('declared thinking form of an anthropic target', () => {
  it('accepts the adaptive form with the effort levels the target accepts', async () => {
    const reasoning = { control: 'thinking', form: 'adaptive', efforts: ['low', 'medium', 'high'] };
    const { settings } = await load(anthropicTarget(reasoning));
    expect(settings.models.targets['remote']).toMatchObject({ capabilities: { reasoning } });
  });

  it('accepts the budget form with a declared budget per level', async () => {
    const reasoning = { control: 'thinking', form: 'budget', budgets: { low: 1024, high: 6000 } };
    const { settings } = await load(anthropicTarget(reasoning));
    expect(settings.models.targets['remote']).toMatchObject({ capabilities: { reasoning } });
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
});
