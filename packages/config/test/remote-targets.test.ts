import { describe, expect, it } from 'vitest';
import { credentialEnvNames, loadSettings, loadUserSettings, secretNames } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };
const IMAGE_TOKENS = { pixelsPerToken: 750, maxTokens: 1600 };

const anthropicTarget = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'anthropic',
  model: 'claude-fake',
  baseUrl: 'https://api.anthropic.com',
  apiKeySecret: 'anthropic-main',
  capabilities: CAPABILITIES,
  ...overrides,
});

const openResponsesTarget = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'open-responses',
  provider: 'fake',
  model: 'llama-fake',
  baseUrl: 'http://127.0.0.1:11434/v1',
  capabilities: CAPABILITIES,
  ...overrides,
});

const loadWithTargets = async (targets: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { targets, aliases: { default: Object.keys(targets)[0] } } });
  return { tree, result: await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const expectRejected = async (targets: Record<string, unknown>, ...fragments: Array<string | RegExp>): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { targets } });
  const failure = loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
  await expect(failure).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(failure).rejects.toThrow(fragment);
};

describe('anthropic target', () => {
  it('resolves with declared capabilities and the Anthropic capability defaults', async () => {
    const { result } = await loadWithTargets({ claude: anthropicTarget() });
    expect(result.settings.models.targets['claude']).toEqual({
      adapter: 'anthropic',
      model: 'claude-fake',
      baseUrl: 'https://api.anthropic.com',
      apiKeySecret: 'anthropic-main',
      toolCalling: 'native',
      billing: 'metered',
      capabilities: {
        contextWindow: 200000,
        maxOutputTokens: 8192,
        structuredOutput: 'none',
        streaming: true,
        stopSequences: false,
        imageInput: false,
        parallelToolCalls: true,
        schemaDialect: 'json-schema-2020-12',
        tokenCounting: 'exact',
        usageReported: true,
        source: 'config',
        maxConcurrency: 4,
      },
      maxConcurrency: 4,
      admissionTimeoutMs: 30000,
    });
  });

  it('accepts a socketPath outside the run directory', async () => {
    const tree = makeTree();
    const socketPath = `${tree.project}/anthropic.sock`;
    writeJson(userSettingsPath(tree), {
      models: { targets: { claude: anthropicTarget({ baseUrl: undefined, socketPath }) }, aliases: { default: 'claude' } },
    });
    const { settings } = await loadUserSettings({ home: tree.home });
    expect(settings.models.targets['claude']).toMatchObject({ adapter: 'anthropic', socketPath });
  });

  it('accepts apiKeyEnv instead of apiKeySecret', async () => {
    const { result } = await loadWithTargets({ claude: anthropicTarget({ apiKeySecret: undefined, apiKeyEnv: 'ANTHROPIC_API_KEY' }) });
    expect(result.settings.models.targets['claude']).toMatchObject({ apiKeyEnv: 'ANTHROPIC_API_KEY' });
  });

  it('requires a credential reference', async () => {
    await expectRejected({ claude: anthropicTarget({ apiKeySecret: undefined }) });
  });

  it('rejects both credential references at once', async () => {
    await expectRejected({ claude: anthropicTarget({ apiKeyEnv: 'ANTHROPIC_API_KEY' }) });
  });

  it('requires declared contextWindow and maxOutputTokens', async () => {
    await expectRejected({ claude: anthropicTarget({ capabilities: { contextWindow: 200000 } }) });
    await expectRejected({ claude: anthropicTarget({ capabilities: { maxOutputTokens: 8192 } }) });
  });

  it('accepts a declared imageInput', async () => {
    const { result } = await loadWithTargets({ claude: anthropicTarget({ capabilities: { ...CAPABILITIES, imageInput: true, imageTokens: IMAGE_TOKENS } }) });
    expect(result.settings.models.targets['claude']).toMatchObject({ capabilities: { imageInput: true } });
  });

  it('accepts a declared imageInput on an open-responses target', async () => {
    const { result } = await loadWithTargets({ local: openResponsesTarget({ capabilities: { ...CAPABILITIES, imageInput: true, imageTokens: IMAGE_TOKENS } }) });
    expect(result.settings.models.targets['local']).toMatchObject({ capabilities: { imageInput: true } });
  });

  it('rejects a plain http baseUrl for a non-loopback host', async () => {
    await expectRejected({ claude: anthropicTarget({ baseUrl: 'http://api.example.com' }) }, 'https');
  });

  it('rejects toolCalling, which is always native', async () => {
    await expectRejected({ claude: anthropicTarget({ toolCalling: 'constrained' }) });
  });

  it.each(['has space', '-leading', '', 'a/b', 'x'.repeat(129)])('rejects apiKeySecret %j', async (apiKeySecret) => {
    await expectRejected({ claude: anthropicTarget({ apiKeySecret }) });
  });
});

describe('open-responses target', () => {
  it('resolves without a credential and with relay capability defaults', async () => {
    const { result } = await loadWithTargets({ local: openResponsesTarget() });
    expect(result.settings.models.targets['local']).toEqual({
      adapter: 'open-responses',
      provider: 'fake',
      model: 'llama-fake',
      baseUrl: 'http://127.0.0.1:11434/v1',
      toolCalling: 'native',
      billing: 'metered',
      capabilities: {
        contextWindow: 200000,
        maxOutputTokens: 8192,
        structuredOutput: 'none',
        streaming: true,
        stopSequences: false,
        imageInput: false,
        parallelToolCalls: false,
        schemaDialect: 'json-schema-2020-12',
        tokenCounting: 'estimated',
        usageReported: true,
        source: 'config',
        maxConcurrency: 4,
      },
      maxConcurrency: 4,
      admissionTimeoutMs: 30000,
    });
  });

  it('accepts toolCalling none and per-target capability overrides', async () => {
    const { result } = await loadWithTargets({
      local: openResponsesTarget({ toolCalling: 'none', capabilities: { ...CAPABILITIES, parallelToolCalls: true, usageReported: false } }),
    });
    const target = result.settings.models.targets['local'];
    expect(target).toMatchObject({ toolCalling: 'none', capabilities: { parallelToolCalls: true, usageReported: false } });
  });

  it('rejects toolCalling constrained', async () => {
    await expectRejected({ local: openResponsesTarget({ toolCalling: 'constrained' }) });
  });

  it('rejects both credential references at once', async () => {
    await expectRejected({ local: openResponsesTarget({ apiKeyEnv: 'OPENROUTER_API_KEY', apiKeySecret: 'openrouter' }) });
  });

  it('requires exactly one of baseUrl and socketPath', async () => {
    await expectRejected({ local: openResponsesTarget({ baseUrl: undefined }) }, 'exactly one of baseUrl and socketPath');
  });
});

describe('chat-completions apiKeySecret', () => {
  it('accepts a stored secret reference and rejects it together with apiKeyEnv', async () => {
    const chat = (overrides: Record<string, unknown>) => ({
      adapter: 'chat-completions',
      provider: 'fake',
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
      capabilities: CAPABILITIES,
      ...overrides,
    });
    const { result } = await loadWithTargets({ remote: chat({ apiKeySecret: 'openai' }) });
    expect(result.settings.models.targets['remote']).toMatchObject({ apiKeySecret: 'openai' });
    await expectRejected({ remote: chat({ apiKeySecret: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }) });
  });
});

describe('secretNames and credentialEnvNames', () => {
  it('lists the sorted unique secret names and env names across adapters', async () => {
    const { tree } = await loadWithTargets({
      a: anthropicTarget({ apiKeySecret: 'zeta' }),
      b: anthropicTarget({ apiKeySecret: undefined, apiKeyEnv: 'ANTHROPIC_API_KEY' }),
      c: openResponsesTarget({ apiKeySecret: 'alpha' }),
      d: openResponsesTarget({ apiKeySecret: 'zeta' }),
      e: openResponsesTarget({ apiKeyEnv: 'OPENROUTER_API_KEY' }),
      f: openResponsesTarget(),
      g: { adapter: 'fm' },
    });
    const { settings } = await loadUserSettings({ home: tree.home });
    expect(secretNames(settings)).toEqual(['alpha', 'zeta']);
    expect(credentialEnvNames(settings)).toEqual(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
  });

  it('lists no secrets for the default settings', async () => {
    const tree = makeTree();
    const { settings } = await loadUserSettings({ home: tree.home });
    expect(secretNames(settings)).toEqual([]);
  });
});

describe('targets are user settings only', () => {
  it('discards anthropic and open-responses targets from project settings with a warning', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { models: { targets: { claude: anthropicTarget() } } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(Object.keys(result.settings.models.targets)).toEqual(['fm']);
    expect(result.warnings.some((warning) => warning.includes('models.targets is only honored in user settings'))).toBe(true);
  });
});
