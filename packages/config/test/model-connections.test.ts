import dns from 'node:dns';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialEnvNames, planAccountNames, secretNames } from '@momonga/config';
import { CAPABILITIES, S1, S2, S2H, S3, S3_PLAN, S4, chatConnection, ollamaConnection } from './model-fixtures.ts';
import { loadFile, loadModelsSection, loadWithProject, refusalOf, sentenceOf } from './load-models.ts';
import type { LoadedModels } from './load-models.ts';

const SCHEMA_REFUSAL = 'must NOT have additional properties';

const keysOf = (models: LoadedModels): string[] => [...models.models.keys()];

const modelAt = (models: LoadedModels, canon: string): Record<string, unknown> => {
  const model = models.models.get(canon);
  if (model === undefined) throw new Error(`${canon} is not resolved; resolved: ${keysOf(models).join(', ')}`);
  return model;
};

const names = (resolved: unknown): { env: string[]; secrets: string[]; accounts: unknown[] } => {
  const reader = <T>(read: unknown): T => (read as (models: unknown) => T)(resolved);
  return { env: reader<string[]>(credentialEnvNames), secrets: reader<string[]>(secretNames), accounts: reader<unknown[]>(planAccountNames) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('models.connections: one object per server or account, each listing its models', () => {
  it('the examples of the design load, and each model is keyed by its server name and its own name', async () => {
    expect(keysOf((await loadFile(S1)).models)).toEqual(['ollama/devstral-small-2:latest', 'ollama/qwen3.8:27b']);
    expect(keysOf((await loadFile(S2)).models)).toEqual(['ollama/gemma-3-4b:latest', 'lmstudio/gemma-3-4b']);
    expect(keysOf((await loadFile(S2H)).models)).toEqual(['ollama/gemma-3-4b:latest', 'srv-127.0.0.1-1234/gemma-3-4b']);
    expect(keysOf((await loadFile(S3)).models)).toEqual(['chatgpt/gpt-5.5', 'openai/gpt-5.5']);
    expect(keysOf((await loadFile(S4)).models)).toEqual(['llama-server/qwen3-coder-30b']);
    const s1 = (await loadFile(S1)).models;
    expect(s1.views).toEqual([
      { canon: 'ollama/devstral-small-2:latest', provider: 'ollama', ownName: 'devstral-small-2:latest', defaultTag: 'latest' },
      { canon: 'ollama/qwen3.8:27b', provider: 'ollama', ownName: 'qwen3.8:27b', defaultTag: 'latest' },
    ]);
    expect(modelAt(s1, 'ollama/qwen3.8:27b')).toMatchObject({ canon: 'ollama/qwen3.8:27b', provider: 'ollama', ownName: 'qwen3.8:27b', model: 'qwen3.8:27b', defaultTag: 'latest', adapter: 'ollama' });
    expect((await loadFile(S2)).models.views[1]).toEqual({ canon: 'lmstudio/gemma-3-4b', provider: 'lmstudio', ownName: 'gemma-3-4b' });
  });

  it('the built-in managed server is named by its description, so its model is apple/<id>', async () => {
    const { models } = await loadModelsSection({ connections: [{ adapter: 'managed', server: 'fm', models: [{ id: 'x' }] }] });
    expect(keysOf(models)).toEqual(['apple/x']);
    expect(modelAt(models, 'apple/x')).toMatchObject({ adapter: 'managed', server: 'fm', model: 'x', provider: 'apple' });
  });

  it('an Ollama id without a tag is read with the default tag; another kind keeps the id as written', async () => {
    const { models } = await loadModelsSection({
      connections: [ollamaConnection('http://127.0.0.1:11434', ['devstral-small-2', 'example/model', 'qwen3.8:27b']), chatConnection('http://127.0.0.1:1234/v1', ['devstral-small-2'])],
    });
    expect(keysOf(models)).toEqual(['ollama/devstral-small-2:latest', 'ollama/example/model:latest', 'ollama/qwen3.8:27b', 'srv-127.0.0.1-1234/devstral-small-2']);
    expect(modelAt(models, 'ollama/devstral-small-2:latest')['model']).toBe('devstral-small-2:latest');
  });
});

describe('a connection the loader refuses, each with its one sentence', () => {
  it('an id listed twice in one connection', async () => {
    expect(await sentenceOf({ models: { connections: [chatConnection('http://127.0.0.1:8080/v1', ['x', 'y', 'x'])] } })).toBe('models.connections[0].models[2]: the id "x" is already listed at models.connections[0].models[0]');
  });

  it('an id without a tag beside the same id with the default tag, under a kind that has one', async () => {
    expect(await sentenceOf({ models: { connections: [chatConnection('http://127.0.0.1:8080/v1'), ollamaConnection('http://127.0.0.1:11434', ['devstral-small-2', 'devstral-small-2:latest'])] } })).toBe(
      'models.connections[1].models[1]: "devstral-small-2:latest" is the same model as "devstral-small-2" at models.connections[1].models[0] (an id without a tag means the tag latest)',
    );
  });

  it('a managed connection with two entries', async () => {
    expect(await sentenceOf({ models: { connections: [{ adapter: 'managed', server: 'fm', models: [{ id: 'x' }, { id: 'y' }] }] } })).toBe('models.connections[0]: a managed server serves one model; list one entry');
  });

  it('a managed connection with no model entry gets the managed sentence and no other', async () => {
    const sentence = 'models.connections[0]: a managed server needs its model listed; run /models add to read it from the server';
    expect(await sentenceOf({ models: { connections: [{ adapter: 'managed', server: 'fm' }] } })).toBe(sentence);
    expect(await sentenceOf({ models: { connections: [{ adapter: 'managed', server: 'fm', models: [] }] } })).toBe(sentence);
  });

  it('a connection of any other adapter with no models or an empty list', async () => {
    const sentence = 'models.connections[0]: models must list at least one model; run /models add to add one';
    expect(await sentenceOf({ models: { connections: [{ adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434' }] } })).toBe(sentence);
    expect(await sentenceOf({ models: { connections: [{ adapter: 'chat-completions', baseUrl: 'http://127.0.0.1:8080/v1', models: [] }] } })).toBe(sentence);
    expect(await sentenceOf({ models: { connections: [S3_PLAN, { adapter: 'open-responses', plan: { profile: 'chatgpt', account: 'chatgpt-2' } }] } })).toBe('models.connections[1]: models must list at least one model; run /models add to add one');
  });

  it('an unknown key in a connection', async () => {
    const { file, message } = await refusalOf({ models: { connections: [chatConnection('http://127.0.0.1:8080/v1', ['m'], { model: 'm' })] } });
    expect(message.startsWith(`${file}: invalid settings at /models/connections/0`)).toBe(true);
    expect(message).toContain(SCHEMA_REFUSAL);
  });

  it('an unknown key in a model entry', async () => {
    const { file, message } = await refusalOf({ models: { connections: [{ adapter: 'chat-completions', baseUrl: 'http://127.0.0.1:8080/v1', models: [{ id: 'm', capabilities: CAPABILITIES, baseUrl: 'http://127.0.0.1:1/v1' }] }] } });
    expect(message.startsWith(`${file}: invalid settings at /models/connections/0`)).toBe(true);
    expect(message).toContain(SCHEMA_REFUSAL);
  });
});

describe('what a connection may leave out, and what each default is', () => {
  it('provider is optional on chat-completions and open-responses, and allowed on anthropic, ollama and managed', async () => {
    const derived = await loadModelsSection({
      connections: [chatConnection('http://127.0.0.1:8080/v1'), { adapter: 'open-responses', baseUrl: 'https://responses.example.com/v1', models: [{ id: 'm', capabilities: CAPABILITIES }] }],
    });
    expect(keysOf(derived.models)).toEqual(['srv-127.0.0.1-8080/m', 'srv-responses.example.com-443/m']);
    const written = await loadModelsSection({
      connections: [
        { adapter: 'anthropic', provider: 'claude-work', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-x', capabilities: CAPABILITIES }] },
        ollamaConnection('http://127.0.0.1:11434', ['m'], { provider: 'home-pc' }),
        { adapter: 'managed', server: 'fm', provider: 'on-device', models: [{ id: 'x' }] },
      ],
    });
    expect(keysOf(written.models)).toEqual(['claude-work/claude-x', 'home-pc/m:latest', 'on-device/x']);
  });

  it('a model entry overrides the concurrency and the wait of its connection; the defaults are 1 local, 4 remote and 30000 ms', async () => {
    const { models } = await loadModelsSection({
      connections: [
        ollamaConnection('http://127.0.0.1:11434', ['a']),
        chatConnection('https://api.example.com/v1', ['b']),
        {
          adapter: 'chat-completions',
          provider: 'tuned',
          baseUrl: 'https://tuned.example.com/v1',
          maxConcurrency: 6,
          admissionTimeoutMs: 1000,
          models: [
            { id: 'c', capabilities: CAPABILITIES },
            { id: 'd', capabilities: CAPABILITIES, maxConcurrency: 2, admissionTimeoutMs: 0 },
          ],
        },
        { adapter: 'managed', server: 'fm', models: [{ id: 'x' }] },
      ],
    });
    const serving = (canon: string) => ({ maxConcurrency: modelAt(models, canon)['maxConcurrency'], admissionTimeoutMs: modelAt(models, canon)['admissionTimeoutMs'] });
    expect(serving('ollama/a:latest')).toEqual({ maxConcurrency: 1, admissionTimeoutMs: 30000 });
    expect(serving('srv-api.example.com-443/b')).toEqual({ maxConcurrency: 4, admissionTimeoutMs: 30000 });
    expect(serving('tuned/c')).toEqual({ maxConcurrency: 6, admissionTimeoutMs: 1000 });
    expect(serving('tuned/d')).toEqual({ maxConcurrency: 2, admissionTimeoutMs: 0 });
    expect(serving('apple/x')).toEqual({ maxConcurrency: 1, admissionTimeoutMs: 30000 });
  });

  it('billing is local for Ollama and a managed server, the profile billing for a plan, metered otherwise, and a written billing wins', async () => {
    const { models } = await loadModelsSection({
      connections: [
        ollamaConnection('http://127.0.0.1:11434', ['a']),
        { adapter: 'managed', server: 'fm', models: [{ id: 'x' }] },
        S3_PLAN,
        chatConnection('https://api.example.com/v1', ['b']),
        chatConnection('http://127.0.0.1:1234/v1', ['c'], { billing: 'local' }),
      ],
    });
    expect([...models.models.values()].map((model) => [model['canon'], model['billing']])).toEqual([
      ['ollama/a:latest', 'local'],
      ['apple/x', 'local'],
      ['chatgpt/gpt-5.5', 'plan'],
      ['srv-api.example.com-443/b', 'metered'],
      ['srv-127.0.0.1-1234/c', 'local'],
    ]);
  });

  it('models in a project settings file is discarded with the warning that names the file, in the new shape too', async () => {
    const { models, warnings, projectFile } = await loadWithProject(S1, { models: { connections: [chatConnection('https://evil.example.com/v1', ['x'])], start: 'srv-evil.example.com-443/x' } });
    expect(keysOf(models)).toEqual(['ollama/devstral-small-2:latest', 'ollama/qwen3.8:27b']);
    expect(models.start).toBe('ollama/devstral-small-2:latest');
    expect(warnings).toContain(`${projectFile}: models.connections is only honored in user settings; discarded`);
    expect(warnings).toContain(`${projectFile}: models.start is only honored in user settings; discarded`);
  });

  it('the credential names and the plan accounts are read over the connections, sorted and once each; a key server without a written name gets its address name', async () => {
    const keyed = (host: string, key: Record<string, string>, ids: readonly string[]) => chatConnection(`https://${host}/v1`, ids, key);
    const { models } = await loadModelsSection({
      connections: [
        keyed('b.example.com', { apiKeyEnv: 'ZED_KEY' }, ['m', 'n']),
        keyed('a.example.com', { apiKeyEnv: 'ALPHA_KEY' }, ['m']),
        keyed('c.example.com', { apiKeyEnv: 'ZED_KEY' }, ['m']),
        keyed('d.example.com', { apiKeySecret: 'work-secret' }, ['m']),
        keyed('e.example.com', { apiKeySecret: 'alpha-secret' }, ['m', 'n']),
        { adapter: 'open-responses', plan: { profile: 'chatgpt', account: 'chatgpt-2' }, models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }] },
        { adapter: 'open-responses', plan: { profile: 'chatgpt', account: 'chatgpt-1' }, models: [{ id: 'gpt-5.5' }] },
        S3_PLAN,
        chatConnection('https://api.openai.com/v1', ['gpt-5.5']),
      ],
    });
    expect(names(models)).toEqual({
      env: ['ALPHA_KEY', 'ZED_KEY'],
      secrets: ['alpha-secret', 'work-secret'],
      accounts: [
        { profile: 'chatgpt', account: 'chatgpt-1' },
        { profile: 'chatgpt', account: 'chatgpt-2' },
      ],
    });
    expect(keysOf(models)).toContain('srv-api.openai.com-443/gpt-5.5');
    expect(modelAt(models, 'srv-api.openai.com-443/gpt-5.5')).toMatchObject({ provider: 'srv-api.openai.com-443', billing: 'metered' });
    expect(keysOf(models).filter((canon) => canon.startsWith('chatgpt'))).toEqual(['chatgpt-2/gpt-5.5', 'chatgpt-2/gpt-5.5-mini', 'chatgpt-1/gpt-5.5', 'chatgpt/gpt-5.5']);
  });

  it('loading asks no server: no request, no connection and no name lookup is made', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the loader made a network request'));
    const connected = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
      throw new Error('the loader opened a connection');
    });
    const looked = vi.spyOn(dns, 'lookup').mockImplementation(() => {
      throw new Error('the loader looked a host name up');
    });
    for (const file of [S1, S2, S2H, S3]) await loadFile(file);
    expect(keysOf((await loadFile(S2H)).models)).toEqual(['ollama/gemma-3-4b:latest', 'srv-127.0.0.1-1234/gemma-3-4b']);
    expect([fetched.mock.calls.length, connected.mock.calls.length, looked.mock.calls.length]).toEqual([0, 0, 0]);
  });
});
