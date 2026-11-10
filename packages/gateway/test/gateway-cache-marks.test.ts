import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, startGateway } from './gateway-helpers.ts';

const message = (role: 'system' | 'user' | 'assistant', text: string) => ({ type: 'message', role, content: text });

const INPUT = [message('system', 'rules'), message('system', 'memory'), message('user', 'task'), message('assistant', 'step one'), message('user', 'go on')];

const MARKS = { stable: 1, fixed: 2, previousHistory: 4, history: 5 };

const KEY = 'stable-prefix-key-0001';

const answering = (model: string) => ({ events: textResponseEvents({ model, chunks: ['ok'], usage: usageOf(9, 3) }) });

const tool = { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } };

describe('the gateway hands the cache marks and the key of a request to the adapter', () => {
  it('passes momonga.cache as cacheMarks and prompt_cache_key as promptCacheKey', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await readJson(
      await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT, tools: [tool], prompt_cache_key: KEY, momonga: { cache: MARKS } }),
    );

    expect(response.status).toBe(200);
    expect(primary.calls).toHaveLength(1);
    expect(primary.calls[0]?.request.cacheMarks).toEqual(MARKS);
    expect(primary.calls[0]?.request.promptCacheKey).toBe(KEY);
  });

  it('passes marks without previousHistory unchanged, with no previousHistory added', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const marks = { stable: 1, fixed: 2, history: 5 };

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT, momonga: { cache: marks } }));

    expect(response.status).toBe(200);
    expect(primary.calls[0]?.request.cacheMarks).toEqual(marks);
    expect(primary.calls[0]?.request).not.toHaveProperty('promptCacheKey');
  });

  it('gives the adapter neither marks nor key when the client sends none', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT }));

    expect(response.status).toBe(200);
    expect(primary.calls[0]?.request).not.toHaveProperty('cacheMarks');
    expect(primary.calls[0]?.request).not.toHaveProperty('promptCacheKey');
  });

  it('gives a fallback target the same marks and key as the target that failed, because they are target-agnostic', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'primary is down' } }] });
    const secondary = createScriptedAdapter({ calls: [answering('scripted-secondary')] });
    const { client } = await startGateway({
      adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary },
      config: {
        chains: { 'scripted/scripted-primary': ['scripted/scripted-primary', 'scripted/scripted-secondary'] },
        targets: { 'scripted/scripted-primary': {}, 'scripted/scripted-secondary': {} },
        retry: { maxAttempts: 1, totalWaitMs: 1 },
      },
    });

    const response = await readJson(
      await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT, prompt_cache_key: KEY, momonga: { cache: MARKS } }),
    );

    expect(response.status).toBe(200);
    expect(response.body.momonga.fallbackFrom).toEqual(['scripted/scripted-primary']);
    expect(primary.calls[0]?.request.cacheMarks).toEqual(MARKS);
    expect(secondary.calls[0]?.request.cacheMarks).toEqual(MARKS);
    expect(primary.calls[0]?.request.promptCacheKey).toBe(KEY);
    expect(secondary.calls[0]?.request.promptCacheKey).toBe(KEY);
  });
});

describe('the gateway refuses marks that do not describe the input', () => {
  const cases: Array<{ name: string; cache: unknown }> = [
    { name: 'a mark that is not an integer', cache: { stable: 1.5, fixed: 2, history: 5 } },
    { name: 'a mark given as a string', cache: { stable: '1', fixed: 2, history: 5 } },
    { name: 'a negative mark', cache: { stable: -1, fixed: 2, history: 5 } },
    { name: 'fixed before stable', cache: { stable: 2, fixed: 1, history: 5 } },
    { name: 'history before fixed', cache: { stable: 1, fixed: 3, history: 2 } },
    { name: 'previousHistory before fixed', cache: { stable: 1, fixed: 3, previousHistory: 2, history: 5 } },
    { name: 'previousHistory after history', cache: { stable: 1, fixed: 2, previousHistory: 5, history: 4 } },
    { name: 'history beyond the input', cache: { stable: 1, fixed: 2, history: 6 } },
    { name: 'a missing history mark', cache: { stable: 1, fixed: 2 } },
    { name: 'an unknown mark', cache: { stable: 1, fixed: 2, history: 5, tools: 0 } },
    { name: 'marks that are not an object', cache: [1, 2, 5] },
  ];

  it.for(cases)('answers 400 invalid_request for $name, before any adapter is called', async ({ cache }) => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT, momonga: { cache } }));

    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_body' });
    expect(response.body.error.param).toMatch(/^momonga\.cache/);
    expect(primary.calls).toHaveLength(0);
  });

  it('answers 400 invalid_request for an unknown key under momonga', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT, momonga: { cache: MARKS, pin: true } }));

    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_body', param: 'momonga.pin' });
    expect(primary.calls).toHaveLength(0);
  });

  it('accepts marks equal to each other and to the input length', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const marks = { stable: 5, fixed: 5, previousHistory: 5, history: 5 };

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT, momonga: { cache: marks } }));

    expect(response.status).toBe(200);
    expect(primary.calls[0]?.request.cacheMarks).toEqual(marks);
  });

  it('accepts all marks at zero', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const marks = { stable: 0, fixed: 0, history: 0 };

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: INPUT, momonga: { cache: marks } }));

    expect(response.status).toBe(200);
    expect(primary.calls[0]?.request.cacheMarks).toEqual(marks);
  });
});
