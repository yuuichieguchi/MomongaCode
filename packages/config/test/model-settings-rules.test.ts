import { describe, expect, it } from 'vitest';
import { CAPABILITIES, S3_PLAN, chatConnection } from './model-fixtures.ts';
import { loadModelsSection, sentenceOf } from './load-models.ts';
import type { LoadedModels } from './load-models.ts';

const LOCAL_ADDRESS = 'http://127.0.0.1:8080/v1';
const IMAGE_TOKENS = { pixelsPerToken: 750, maxTokens: 1600, minTokens: 85 };

const modelAt = (models: LoadedModels, canon: string): Record<string, unknown> => {
  const model = models.models.get(canon);
  if (model === undefined) throw new Error(`${canon} is not resolved; resolved: ${[...models.models.keys()].join(', ')}`);
  return model;
};

const capabilitiesAt = (models: LoadedModels, canon: string): Record<string, unknown> => modelAt(models, canon)['capabilities'] as Record<string, unknown>;

const chatWith = (capabilities: Record<string, unknown>) => ({ adapter: 'chat-completions', provider: 'local', baseUrl: LOCAL_ADDRESS, models: [{ id: 'm', capabilities: { ...CAPABILITIES, ...capabilities } }] });

const planWith = (extra: Record<string, unknown>) => ({ ...S3_PLAN, ...extra });

describe('capability defaults per adapter, read through the loader', () => {
  it('an anthropic model gets the anthropic wire facts and keeps its declared numbers', async () => {
    const connection = { adapter: 'anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-x', capabilities: CAPABILITIES }] };
    const capabilities = capabilitiesAt((await loadModelsSection({ connections: [connection] })).models, 'anthropic/claude-x');
    expect(capabilities).toMatchObject({ ...CAPABILITIES, stopSequences: false, parallelToolCalls: true, tokenCounting: 'exact', promptCache: { kind: 'breakpoints', maxBreakpoints: 4 } });
  });

  it('an ollama model gets json_schema structured output and no stop sequences', async () => {
    const connection = { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'q:1', capabilities: CAPABILITIES }] };
    expect(capabilitiesAt((await loadModelsSection({ connections: [connection] })).models, 'ollama/q:1')).toMatchObject({ structuredOutput: 'json_schema', stopSequences: false });
  });

  it('an open-responses model has no stop sequences, and a chat-completions model is not given that fact', async () => {
    const open = { adapter: 'open-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'g', capabilities: CAPABILITIES }] };
    const { models } = await loadModelsSection({ connections: [open, chatConnection(LOCAL_ADDRESS, ['c'])] });
    expect(capabilitiesAt(models, 'openai/g')['stopSequences']).toBe(false);
    expect(capabilitiesAt(models, 'srv-127.0.0.1-8080/c')['stopSequences']).not.toBe(false);
  });
});

describe('image tokens: an image-reading model declares how it counts an image', () => {
  it('keeps the declared image token model on the resolved capabilities', async () => {
    const { models } = await loadModelsSection({ connections: [chatWith({ imageInput: true, imageTokens: IMAGE_TOKENS })] });
    expect(capabilitiesAt(models, 'local/m')).toMatchObject({ imageInput: true, imageTokens: IMAGE_TOKENS });
  });

  it('refuses imageInput without imageTokens, naming the entry and the missing field', async () => {
    expect(await sentenceOf({ models: { connections: [chatWith({ imageInput: true })] } })).toMatch(/models\.connections\[0\]\.models\[0\].*capabilities\.imageInput is true, so capabilities\.imageTokens/);
  });

  it('refuses imageTokens on a model that does not read images', async () => {
    expect(await sentenceOf({ models: { connections: [chatWith({ imageInput: false, imageTokens: IMAGE_TOKENS })] } })).toMatch(/capabilities\.imageTokens is declared but capabilities\.imageInput is false/);
  });
});

describe('systemRole, toolPlacement and inputKinds: how an open-responses route carries a request', () => {
  const openWith = (capabilities: Record<string, unknown>) => ({
    adapter: 'open-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [{ id: 'g', capabilities: { ...CAPABILITIES, ...capabilities } }],
  });
  const ROUTE = { systemRole: 'developer', toolPlacement: 'additional_tools', inputKinds: { content: ['file'], tools: ['function'] } };

  it('keeps the values the protocol knows on an open-responses model', async () => {
    expect(capabilitiesAt((await loadModelsSection({ connections: [openWith(ROUTE)] })).models, 'openai/g')).toMatchObject(ROUTE);
  });

  it.each([
    ['systemRole', { systemRole: 'assistant' }],
    ['toolPlacement', { toolPlacement: 'inline' }],
    ['inputKinds', { inputKinds: { content: ['smell'] } }],
  ])('refuses a %s it does not know, naming the field', async (field, declared) => {
    expect(await sentenceOf({ models: { connections: [openWith(declared)] } })).toContain(`capabilities/${field}`);
  });

  it.each(Object.keys(ROUTE))('refuses %s on a chat-completions model, whose wire has no such route', async (field) => {
    expect(await sentenceOf({ models: { connections: [chatWith({ [field]: ROUTE[field as keyof typeof ROUTE] })] } })).toBe(
      `invalid settings at /models/connections/0/models/0/capabilities/${field}: must NOT have additional properties`,
    );
  });
});

describe('schema dialects', () => {
  const declaredDialect = { rules: [] };

  it('a model may name a dialect declared in models.dialects', async () => {
    const { models } = await loadModelsSection({ dialects: { mine: { extends: 'strict-closed', ...declaredDialect } }, connections: [chatWith({ schemaDialect: 'mine' })] });
    expect(capabilitiesAt(models, 'local/m')['schemaDialect']).toBe('mine');
  });

  it('refuses a model dialect that is neither built in nor declared, naming the id', async () => {
    expect(await sentenceOf({ models: { connections: [chatWith({ schemaDialect: 'nowhere' })] } })).toBe(
      'models.connections[0].models[0]: capabilities.schemaDialect "nowhere" is neither a built-in dialect nor declared in models.dialects',
    );
  });

  it('refuses a declared dialect that extends one that is not built in, naming both', async () => {
    expect(await sentenceOf({ models: { dialects: { mine: { extends: 'other', ...declaredDialect } } } })).toMatch(/models\.dialects\.mine: extends "other", which is not a built-in dialect/);
  });

  it('refuses a declared dialect that redefines a built-in one', async () => {
    expect(await sentenceOf({ models: { dialects: { 'strict-closed': declaredDialect } } })).toBe('models.dialects.strict-closed: "strict-closed" is the id of a built-in dialect and cannot be redefined');
  });
});

describe('socket addresses of a connection', () => {
  it('refuses a relative socketPath', async () => {
    const connection = { adapter: 'chat-completions', provider: 'local', socketPath: 'run/server.sock', models: [{ id: 'm', capabilities: CAPABILITIES }] };
    expect(await sentenceOf({ models: { connections: [connection] } })).toMatch(/socketPath "run\/server\.sock" must be an absolute path/);
  });

  it('refuses a connection with both baseUrl and socketPath, and one with neither', async () => {
    const both = { adapter: 'chat-completions', provider: 'local', baseUrl: LOCAL_ADDRESS, socketPath: '/var/run/x.sock', models: [{ id: 'm', capabilities: CAPABILITIES }] };
    const neither = { adapter: 'chat-completions', provider: 'local', models: [{ id: 'm', capabilities: CAPABILITIES }] };
    expect(await sentenceOf({ models: { connections: [both] } })).toBe('invalid settings at /models/connections/0: baseUrl and socketPath cannot both be written; exactly one names the server');
    expect(await sentenceOf({ models: { connections: [neither] } })).toBe('invalid settings at /models/connections/0: exactly one of baseUrl and socketPath is required');
  });
});

describe('plan connections: the bearer goes only to the profile resource', () => {
  it.each(['apiKeyEnv', 'apiKeySecret'])('refuses a plan combined with %s', async (key) => {
    expect(await sentenceOf({ models: { connections: [planWith({ [key]: 'X' })] } })).toMatch(new RegExp(`plan cannot be combined with ${key}`));
  });

  it('refuses a plan with a socketPath', async () => {
    expect(await sentenceOf({ models: { connections: [planWith({ socketPath: '/var/run/x.sock' })] } })).toMatch(/plan cannot be combined with socketPath; a plan connection sends its bearer only to https:\/\/api\.openai\.com\/v1/);
  });

  it.each(['https://example.com/v1', 'https://api.openai.com:8443/v1'])('refuses the base URL %s whose origin is not the resource origin', async (baseUrl) => {
    expect(await sentenceOf({ models: { connections: [planWith({ baseUrl })] } })).toMatch(/plan profile chatgpt sends its bearer only to origin https:\/\/api\.openai\.com/);
  });

  it('refuses the resource host over plain http, since the connection sends a credential', async () => {
    expect(await sentenceOf({ models: { connections: [planWith({ baseUrl: 'http://api.openai.com/v1' })] } })).toMatch(/^models\.connections\[0\]: baseUrl http:\/\/api\.openai\.com.* must use https: because this connection sends a credential/);
  });

  it('refuses an unknown profile, naming it and the known profiles', async () => {
    expect(await sentenceOf({ models: { connections: [planWith({ plan: { profile: 'nope' } })] } })).toMatch(/unknown plan profile "nope"; the known profiles are "chatgpt"/);
  });

  it('a plan entry with no declared capabilities resolves to the profile defaults, with no number invented', async () => {
    const { models } = await loadModelsSection({ connections: [S3_PLAN] });
    const capabilities = capabilitiesAt(models, 'chatgpt/gpt-5.5');
    expect(capabilities).toMatchObject({ systemRole: 'developer', toolPlacement: 'additional_tools', outputBoundField: 'none' });
    expect(capabilities['contextWindow']).toBeUndefined();
    expect(capabilities['maxOutputTokens']).toBeUndefined();
    expect(modelAt(models, 'chatgpt/gpt-5.5')['billing']).toBe('plan');
  });

  it('a declared capability on a plan entry wins over the profile, and removing it restores the profile default', async () => {
    const declared = { ...S3_PLAN, models: [{ id: 'gpt-5.5', capabilities: { systemRole: 'system' } }] };
    expect(capabilitiesAt((await loadModelsSection({ connections: [declared] })).models, 'chatgpt/gpt-5.5')['systemRole']).toBe('system');
    expect(capabilitiesAt((await loadModelsSection({ connections: [S3_PLAN] })).models, 'chatgpt/gpt-5.5')['systemRole']).toBe('developer');
  });
});

describe('the managed server: declarable fields', () => {
  it('keeps a declared readyTimeoutMs and fills the rest from the server description', async () => {
    const { models } = await loadModelsSection({ connections: [{ adapter: 'managed', server: 'fm', readyTimeoutMs: 1234, models: [{ id: 'x' }] }] });
    expect(modelAt(models, 'apple/x')).toMatchObject({ adapter: 'managed', server: 'fm', readyTimeoutMs: 1234 });
  });

  it('refuses a server id no description declares, listing the declared ids', async () => {
    expect(await sentenceOf({ models: { connections: [{ adapter: 'managed', server: 'nope', models: [{ id: 'x' }] }] } })).toBe('models.connections[0]: server "nope" is not a managed server this build supports; supported: fm');
  });
});
