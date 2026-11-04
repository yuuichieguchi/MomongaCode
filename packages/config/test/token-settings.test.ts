import { describe, expect, it } from 'vitest';
import { loadSettings, loadUserSettings } from '@momonga/config';
import { MAX_BUDGET_COUNT } from '@momonga/protocol';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const resolvedWith = async (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return (await loadUserSettings({ home: tree.home })).settings;
};

const rejectedWith = async (settings: Record<string, unknown>, fragment: string | RegExp): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  await expect(loadUserSettings({ home: tree.home })).rejects.toThrow(fragment);
};

const OFF_CONTEXT = { adaptiveBudget: false, autoCompact: true, cachePrefix: false, outputFormatters: [], loopGuidance: false, observedCapacity: false };

describe('token settings defaults', () => {
  it('turns every context policy of the token design off', async () => {
    expect((await resolvedWith({})).context).toEqual(OFF_CONTEXT);
  });

  it('turns tool deferral and concise descriptions off', async () => {
    expect((await resolvedWith({})).tools).toEqual({ deferral: false, conciseDescriptions: false });
  });

  it('turns repository facts off', async () => {
    expect((await resolvedWith({})).memory).toEqual({ reflection: { enabled: false }, forgetAfterDays: 90, repositoryFacts: false });
  });
});

describe('token settings values', () => {
  it('resolves every key the user sets', async () => {
    const settings = await resolvedWith({
      context: { cachePrefix: true, outputFormatters: ['log', 'json', 'grep', 'identicalOutput'], loopGuidance: true, observedCapacity: true },
      tools: { deferral: true, conciseDescriptions: true },
      memory: { repositoryFacts: true },
    });
    expect(settings.context).toEqual({
      adaptiveBudget: false,
      autoCompact: true,
      cachePrefix: true,
      outputFormatters: ['log', 'json', 'grep', 'identicalOutput'],
      loopGuidance: true,
      observedCapacity: true,
    });
    expect(settings.tools).toEqual({ deferral: true, conciseDescriptions: true });
    expect(settings.memory).toEqual({ reflection: { enabled: false }, forgetAfterDays: 90, repositoryFacts: true });
  });

  it('lets a later layer win each key and keeps the keys it does not set', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { cachePrefix: true, outputFormatters: ['log'] }, tools: { deferral: true } });
    writeJson(projectSettingsPath(tree), { context: { outputFormatters: ['json'] }, tools: { conciseDescriptions: true } });
    const { settings } = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(settings.context).toEqual({ ...OFF_CONTEXT, cachePrefix: true, outputFormatters: ['json'] });
    expect(settings.tools).toEqual({ deferral: true, conciseDescriptions: true });
  });

  it.each([
    [{ context: { cachePrefix: 'yes' } }, /cachePrefix/],
    [{ context: { outputFormatters: ['markdown'] } }, /outputFormatters/],
    [{ context: { loopGuidance: 1 } }, /loopGuidance/],
    [{ context: { observedCapacity: 'on' } }, /observedCapacity/],
    [{ tools: { deferral: 'on' } }, /deferral/],
    [{ tools: { lazy: true } }, /lazy/],
    [{ memory: { repositoryFacts: 'on' } }, /repositoryFacts/],
  ])('refuses %j', async (settings, fragment) => {
    await rejectedWith(settings, fragment);
  });
});

const anthropicTarget = (capabilities: Record<string, unknown>) => ({
  adapter: 'anthropic',
  model: 'claude-fake',
  baseUrl: 'https://api.anthropic.com',
  apiKeySecret: 'anthropic-main',
  capabilities,
});

const openResponsesTarget = {
  adapter: 'open-responses',
  provider: 'fake',
  model: 'llama-fake',
  baseUrl: 'http://127.0.0.1:11434/v1',
  capabilities: { contextWindow: 200000, maxOutputTokens: 8192 },
};

const chatCompletionsTarget = {
  adapter: 'chat-completions',
  provider: 'fake',
  model: 'llama-fake',
  baseUrl: 'http://127.0.0.1:11434/v1',
  capabilities: { contextWindow: 200000, maxOutputTokens: 8192 },
};

describe('the promptCache capability of a target', () => {
  it('declares four breakpoints for an Anthropic target', async () => {
    const settings = await resolvedWith({ models: { targets: { claude: anthropicTarget({ contextWindow: 200000, maxOutputTokens: 8192 }) }, aliases: { default: 'claude' } } });
    expect(settings.models.targets['claude']).toMatchObject({ capabilities: { promptCache: { kind: 'breakpoints', maxBreakpoints: 4 } } });
  });

  it('declares nothing for an open-responses or a chat-completions target, so nothing is sent', async () => {
    const settings = await resolvedWith({ models: { targets: { or: openResponsesTarget, cc: chatCompletionsTarget }, aliases: { default: 'or' } } });
    expect(settings.models.targets['or']).toHaveProperty('capabilities');
    expect(settings.models.targets['or']).not.toHaveProperty('capabilities.promptCache');
    expect(settings.models.targets['cc']).toHaveProperty('capabilities');
    expect(settings.models.targets['cc']).not.toHaveProperty('capabilities.promptCache');
  });
});

describe('the exactness domain of contextWindow', () => {
  it('is 2^33', () => {
    expect(MAX_BUDGET_COUNT).toBe(8_589_934_592);
  });

  it('accepts a context window of exactly 2^33', async () => {
    const settings = await resolvedWith({ models: { targets: { claude: anthropicTarget({ contextWindow: MAX_BUDGET_COUNT, maxOutputTokens: 8192 }) }, aliases: { default: 'claude' } } });
    expect(settings.models.targets['claude']).toMatchObject({ capabilities: { contextWindow: MAX_BUDGET_COUNT } });
  });

  it('refuses a context window above 2^33', async () => {
    await rejectedWith({ models: { targets: { claude: anthropicTarget({ contextWindow: MAX_BUDGET_COUNT + 1, maxOutputTokens: 8192 }) }, aliases: { default: 'claude' } } }, /contextWindow/);
  });
});
