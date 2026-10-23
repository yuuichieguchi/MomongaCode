import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRIPTED_CAPABILITIES, createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { expectErrorBody, getJson, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

describe('POST /v1/momonga/count_tokens', () => {
  it('uses adapter.countTokens when available and reports its method', async () => {
    const primary = createScriptedAdapter({ calls: [], countTokens: { input_tokens: 42, method: 'calibrated', error_bound: 3 } });
    const { client } = await startGateway({ adapters: { primary } });
    const request = { model: 'fast', input: userInput('count me') };
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', request));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ input_tokens: 42, method: 'calibrated', error_bound: 3 });
    expect(primary.countCalls).toHaveLength(1);
    expect(primary.countCalls[0]?.request.input).toEqual(request.input);
    expect(primary.countCalls[0]?.target).toEqual({ name: 'primary', model: 'scripted-primary' });
  });

  it('falls back to a deterministic estimator with method estimated and a non-zero error_bound', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const short = { model: 'fast', input: userInput('short') };
    const long = { model: 'fast', input: userInput('a much longer piece of text '.repeat(40)) };
    const first = (await readJson(await postJson(client, '/v1/momonga/count_tokens', short))).body;
    const again = (await readJson(await postJson(client, '/v1/momonga/count_tokens', short))).body;
    const bigger = (await readJson(await postJson(client, '/v1/momonga/count_tokens', long))).body;
    expect(first.method).toBe('estimated');
    expect(first.input_tokens).toBeGreaterThan(0);
    expect(first.error_bound).toBeGreaterThan(0);
    expect(again).toEqual(first);
    expect(bigger.input_tokens).toBeGreaterThan(first.input_tokens);
  });

  it('rejects an unknown alias with 404 model_not_found', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'nope', input: 'x' }));
    expect(response.status).toBe(404);
    expectErrorBody(response.body, { type: 'not_found', code: 'model_not_found', param: 'model' });
  });
});

describe('models and health', () => {
  const config = {
    aliases: { fast: ['a'], deep: ['b', 'a'] },
    targets: {
      a: { adapter: 'a', model: 'model-a', capabilities: { contextWindow: 4096, toolCalling: 'constrained' as const } },
      b: { adapter: 'b', model: 'model-b' },
    },
  };

  it('lists aliases on /v1/models', async () => {
    const a = createScriptedAdapter({ calls: [] });
    const b = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { a, b }, config });
    const response = await getJson(client, '/v1/models');
    expect(response.status).toBe(200);
    expect(response.body.object).toBe('list');
    expect(response.body.data.map((model: { id: string }) => model.id).sort()).toEqual(['deep', 'fast']);
    for (const model of response.body.data) expect(model.object).toBe('model');
  });

  it('returns per-alias capabilities with config overrides merged over the adapter declaration', async () => {
    const a = createScriptedAdapter({ calls: [], capabilities: { maxOutputTokens: 2048 } });
    const b = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { a, b }, config });
    const response = await getJson(client, '/v1/momonga/models');
    expect(response.status).toBe(200);
    const fast = response.body.data.find((entry: { id: string }) => entry.id === 'fast');
    expect(fast.targets).toEqual(['a']);
    expect(fast.capabilities).toEqual({
      ...DEFAULT_SCRIPTED_CAPABILITIES,
      maxOutputTokens: 2048,
      contextWindow: 4096,
      toolCalling: 'constrained',
      source: 'config',
    });
    const deep = response.body.data.find((entry: { id: string }) => entry.id === 'deep');
    expect(deep.targets).toEqual(['b', 'a']);
  });

  it('reports per-target health and breaker state', async () => {
    const a = createScriptedAdapter({ calls: [] });
    const b = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { a, b }, config });
    const response = await getJson(client, '/v1/momonga/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(Object.keys(response.body.targets).sort()).toEqual(['a', 'b']);
    expect(response.body.targets.a).toMatchObject({ ok: true, breaker: 'closed' });
    expect(response.body.targets.b).toMatchObject({ ok: true, breaker: 'closed' });
  });
});

describe('GET /v1/momonga/usage', () => {
  it('records usage per response, estimates when upstream omits it, and sums per step for a run', async () => {
    const primary = createScriptedAdapter({
      calls: [
        { events: textResponseEvents({ model: 'scripted-primary', chunks: ['one'], usage: usageOf(10, 2) }) },
        { events: textResponseEvents({ model: 'scripted-primary', chunks: ['two'], usage: usageOf(20, 4) }) },
        { events: textResponseEvents({ model: 'scripted-primary', chunks: ['three'], usage: null }) },
        { events: textResponseEvents({ model: 'scripted-primary', chunks: ['other run'], usage: usageOf(99, 99) }) },
      ],
    });
    const { client } = await startGateway({ adapters: { primary } });
    const send = (step: string, runId = 'run-1') =>
      postJson(client, '/v1/responses', { model: 'fast', input: userInput(`step ${step}`), metadata: { run_id: runId, step } });
    const r1 = await readJson(await send('1'));
    const r2 = await readJson(await send('1'));
    const r3 = await readJson(await send('2'));
    await readJson(await send('1', 'run-2'));

    expect(r1.body.momonga.usageSource).toBe('reported');
    expect(r3.body.momonga.usageSource).toBe('estimated');
    expect(r3.body.usage.input_tokens).toBeGreaterThan(0);
    expect(r3.body.usage.output_tokens).toBeGreaterThan(0);
    expect(r3.body.usage.total_tokens).toBe(r3.body.usage.input_tokens + r3.body.usage.output_tokens);

    const report = await getJson(client, '/v1/momonga/usage?run_id=run-1');
    expect(report.status).toBe(200);
    expect(report.body.run_id).toBe('run-1');
    expect(report.body.responses.map((entry: { response_id: string }) => entry.response_id)).toEqual([r1.body.id, r2.body.id, r3.body.id]);
    expect(report.body.responses.map((entry: { usage_source: string }) => entry.usage_source)).toEqual(['reported', 'reported', 'estimated']);
    const estimated = r3.body.usage;
    expect(report.body.steps).toEqual([
      { step: 1, input_tokens: 30, output_tokens: 6, total_tokens: 36 },
      { step: 2, input_tokens: estimated.input_tokens, output_tokens: estimated.output_tokens, total_tokens: estimated.total_tokens },
    ]);
    expect(report.body.total).toEqual({
      input_tokens: 30 + estimated.input_tokens,
      output_tokens: 6 + estimated.output_tokens,
      total_tokens: 36 + estimated.total_tokens,
    });
  });

  it('requires run_id', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await getJson(client, '/v1/momonga/usage');
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_query', param: 'run_id' });
  });

  it('returns an empty report for a run without responses', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await getJson(client, '/v1/momonga/usage?run_id=unknown');
    expect(response.body).toEqual({
      run_id: 'unknown',
      responses: [],
      steps: [],
      total: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
  });
});
