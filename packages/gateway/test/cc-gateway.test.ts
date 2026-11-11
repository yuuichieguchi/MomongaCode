import { describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '@momonga/gateway';
import { DEFAULT_SCRIPTED_CAPABILITIES, createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { START_MS, TEST_VERSION, expectErrorBody, getJson, postJson, readJson, readSse, startGateway, validator } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, readFileTool, startFake } from './cc-support.ts';

const singleTarget = { chains: { 'fm/system': ['fm/system'] }, targets: { 'fm/system': {} } };

const startCcGateway = async (fake: FakeChatCompletionsServer, toolCalling: 'native' | 'constrained' | 'none') => {
  const adapter = makeAdapter(fake, {
    capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling }),
  });
  return startGateway({ adapters: { 'fm/system': adapter }, config: singleTarget });
};

const schemaNames = validator.streamEventSchemaNames();

const specProblems = (frames: Array<{ data: any }>): string[] =>
  frames.flatMap((frame) => {
    const name = schemaNames.get(frame.data.type);
    if (name === undefined) return [`${frame.data.type}: unknown event`];
    return validator.validate(name, frame.data).errors.map((error) => `${frame.data.type}: ${error}`);
  });

const QUESTION = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please use read_file' }] }];

const roundTrip = async (fake: FakeChatCompletionsServer, toolCalling: 'native' | 'constrained') => {
  const { client } = await startCcGateway(fake, toolCalling);
  const first = await readSse(
    await postJson(client, '/v1/responses', {
      model: 'fm/system',
      stream: true,
      tools: [readFileTool],
      input: QUESTION,
    }),
  );
  expect(specProblems(first)).toEqual([]);
  const firstTerminal = first.at(-1)?.data;
  expect(firstTerminal.type).toBe('response.completed');
  const calls = firstTerminal.response.output.filter((item: any) => item.type === 'function_call');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: 'read_file', arguments: '{"path":"value"}' });
  expect(calls[0].call_id).toMatch(/^call_[0-9a-f]{32}$/);
  expect(calls[0].call_id).not.toBe('call_1_0');

  const second = await readSse(
    await postJson(client, '/v1/responses', {
      model: 'fm/system',
      stream: true,
      tools: [readFileTool],
      input: [...QUESTION, ...firstTerminal.response.output, { type: 'function_call_output', call_id: calls[0].call_id, output: 'file body' }],
    }),
  );
  expect(specProblems(second)).toEqual([]);
  const secondTerminal = second.at(-1)?.data;
  expect(secondTerminal.type).toBe('response.completed');
  return { calls, secondTerminal };
};

const textOf = (resource: any): string =>
  resource.output
    .filter((item: any) => item.type === 'message')
    .flatMap((item: any) => item.content)
    .map((part: any) => part.text)
    .join('');

describe('chat-completions adapter through the gateway', () => {
  it('runs a native streamed tool-calling round trip with gateway call ids', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const { calls, secondTerminal } = await roundTrip(fake, 'native');
    expect(textOf(secondTerminal.response)).toBe('Tool result received: file body');
    const followUp = completionBodies(fake).at(-1);
    const assistant = followUp.messages.find((message: any) => message.role === 'assistant');
    expect(assistant.tool_calls[0].id).toBe(calls[0].call_id);
    expect(followUp.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: calls[0].call_id, content: 'file body' });
  });

  it('runs a constrained streamed tool-calling round trip with gateway call ids', async () => {
    const fake = await startFake({ scenario: 'json-schema-only' });
    const { calls, secondTerminal } = await roundTrip(fake, 'constrained');
    expect(secondTerminal.response.output.some((item: any) => item.type === 'function_call')).toBe(false);
    expect(textOf(secondTerminal.response)).toBe('value');
    const followUp = completionBodies(fake).at(-1);
    expect(followUp.messages.at(-1).role).toBe('user');
    expect(followUp.messages.at(-1).content).toContain(`<tool_result call_id="${calls[0].call_id}" name="read_file">`);
    expect(completionBodies(fake).every((body: any) => !('tools' in body))).toBe(true);
  });

  it('never calls the adapter for a tools request when the target has no tool calling', async () => {
    const fake = await startFake({ scenario: 'none' });
    const { client } = await startCcGateway(fake, 'none');
    const response = await readJson(
      await postJson(client, '/v1/responses', {
        model: 'fm/system',
        tools: [readFileTool],
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    );
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'capability_unsupported' });
    expect(completionBodies(fake)).toEqual([]);
  });

  it('passes the routed target to the adapter capabilities', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const seen: unknown[] = [];
    const adapter = makeAdapter(fake, {
      capabilities: async (target) => {
        seen.push(target);
        return CC_CAPABILITIES;
      },
    });
    const { client } = await startGateway({ adapters: { 'fm/system': adapter }, config: singleTarget });
    const models = await getJson(client, '/v1/momonga/models');
    expect(models.body.data[0].capabilities).toEqual(CC_CAPABILITIES);
    expect(seen).toContainEqual({ name: 'fm/system', display: 'system', model: 'system' });
  });
});

const expectHealth = (body: Record<string, unknown>, expected: { ok: boolean; models: Record<string, unknown> }): void => {
  const { ok, models, ...processFields } = body;
  expect({ ok, models }).toEqual(expected);
  expect(Object.keys(processFields).sort()).toEqual(['activeRequests', 'apiVersion', 'pid', 'startedAt', 'state', 'version']);
  expect(processFields).toMatchObject({ version: TEST_VERSION, apiVersion: 1, pid: process.pid, state: 'running' });
  expect(new Date(processFields['startedAt'] as string).getTime()).toBe(START_MS);
};

describe('/v1/momonga/health with adapter health', () => {
  it('merges an unhealthy adapter health result into the target entry', async () => {
    const scripted = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'm', chunks: ['x'] }) }] });
    const seen: unknown[] = [];
    const unhealthy: ProviderAdapter = {
      kind: scripted.kind,
      sampling: scripted.sampling,
      relaysClientBody: scripted.relaysClientBody,
      capabilities: async () => DEFAULT_SCRIPTED_CAPABILITIES,
      toolChoiceWire: () => ({ forms: [], expressesRequired: true }),
      create: (request, ctx) => scripted.create(request, ctx),
      classify: (error) => scripted.classify(error),
      health: async (target) => {
        seen.push(target);
        return { ok: false, reason: 'unhealthy', detail: 'model asset missing' };
      },
    };
    const healthy = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({
      adapters: { 'scripted/m1': unhealthy, 'scripted/m2': healthy },
      config: {
        chains: { 'scripted/m1': ['scripted/m1', 'scripted/m2'] },
        targets: { 'scripted/m1': {}, 'scripted/m2': {} },
      },
    });
    const health = await getJson(client, '/v1/momonga/health');
    expect(health.status).toBe(200);
    expectHealth(health.body, {
      ok: false,
      models: {
        'scripted/m1': { ok: false, breaker: 'closed', reason: 'unhealthy', detail: 'model asset missing' },
        'scripted/m2': { ok: true, breaker: 'closed' },
      },
    });
    expect(seen).toEqual([{ name: 'scripted/m1', display: 'm1', model: 'm1' }]);
  });

  it('reports a healthy adapter as ok', async () => {
    const scripted = createScriptedAdapter({ calls: [] });
    const adapter: ProviderAdapter = {
      kind: scripted.kind,
      sampling: scripted.sampling,
      relaysClientBody: scripted.relaysClientBody,
      capabilities: async () => DEFAULT_SCRIPTED_CAPABILITIES,
      toolChoiceWire: () => ({ forms: [], expressesRequired: true }),
      create: (request, ctx) => scripted.create(request, ctx),
      classify: (error) => scripted.classify(error),
      health: async () => ({ ok: true }),
    };
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': adapter } });
    expectHealth((await getJson(client, '/v1/momonga/health')).body, { ok: true, models: { 'scripted/scripted-primary': { ok: true, breaker: 'closed' } } });
  });
});

describe('/v1/momonga/health with a throwing adapter health', () => {
  it('reports the failing target unhealthy without failing the endpoint', async () => {
    const scripted = createScriptedAdapter({ calls: [] });
    const broken: ProviderAdapter = {
      kind: scripted.kind,
      sampling: scripted.sampling,
      relaysClientBody: scripted.relaysClientBody,
      capabilities: async () => DEFAULT_SCRIPTED_CAPABILITIES,
      toolChoiceWire: () => ({ forms: [], expressesRequired: true }),
      create: (request, ctx) => scripted.create(request, ctx),
      classify: (error) => scripted.classify(error),
      health: async () => {
        throw new Error('probe crashed');
      },
    };
    const { client } = await startGateway({
      adapters: { 'broken/m1': broken, 'scripted/m2': createScriptedAdapter({ calls: [] }) },
      config: {
        chains: { 'broken/m1': ['broken/m1', 'scripted/m2'] },
        targets: { 'broken/m1': {}, 'scripted/m2': {} },
      },
    });
    const health = await getJson(client, '/v1/momonga/health');
    expect(health.status).toBe(200);
    expectHealth(health.body, {
      ok: false,
      models: {
        'broken/m1': { ok: false, breaker: 'closed', reason: 'health_check_failed', detail: 'probe crashed' },
        'scripted/m2': { ok: true, breaker: 'closed' },
      },
    });
  });
});
