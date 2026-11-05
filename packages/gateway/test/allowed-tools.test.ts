import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { AdapterRequest, Capabilities } from '@momonga/protocol';
import { anthropicCountTokensReply, anthropicTextReply, openResponsesTextReply } from '@momonga/testkit';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, collect, lastCompletionBody, makeAdapter, startFake, userText } from './cc-support.ts';
import { OLLAMA_CAPABILITIES, chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway, startOpenResponsesGateway } from './upstream-gateway-support.ts';
import type { UpstreamGateway } from './upstream-gateway-support.ts';

const toolNamed = (name: string) => ({
  type: 'function' as const,
  name,
  description: `the ${name} tool`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});

const TOOLS = [toolNamed('alpha'), toolNamed('beta'), toolNamed('gamma')];
const ALL_NAMES = ['alpha', 'beta', 'gamma'];

const allowed = (names: readonly string[], mode?: 'auto' | 'required' | 'none') => ({
  type: 'allowed_tools' as const,
  tools: names.map((name) => ({ type: 'function' as const, name })),
  ...(mode === undefined ? {} : { mode }),
});

const TWO_REQUIRED = allowed(['alpha', 'beta'], 'required');
const TWO_AUTO = allowed(['alpha', 'beta'], 'auto');
const TWO_NONE = allowed(['alpha', 'beta'], 'none');
const TWO_NO_MODE = allowed(['alpha', 'beta']);
const ONE_REQUIRED = allowed(['alpha'], 'required');

const withAllowedTools = (capabilities: Capabilities, forms: readonly string[]): Capabilities =>
  ({ ...capabilities, allowedTools: forms }) as Capabilities;

const ccRequest = (toolChoice: unknown): AdapterRequest =>
  ({ model: 'system', input: [userText('hello')], tools: TOOLS, tool_choice: toolChoice }) as AdapterRequest;

const ALL_KEYWORDS = { enum: true, anyOf: true, const: true, pattern: true, minimum: true, nested: true, additionalProperties: true };

const ccReply = (content: string) => ({
  kind: 'stream' as const,
  chunks: [{ delta: { role: 'assistant' as const, content } }, { delta: {}, finishReason: 'stop' as const }],
});

const ccNativeSent = async (capabilities: Capabilities, toolChoice: unknown) => {
  const fake = await startFake({ scenario: 'tools-ok', script: [ccReply('ok')] });
  const adapter = makeAdapter(fake, { toolCalling: () => 'native', capabilities: async () => capabilities });
  const { error } = await collect(adapter, ccRequest(toolChoice));
  return { error: error as any, fake };
};

const ccConstrainedSent = async (capabilities: Capabilities, toolChoice: unknown) => {
  const fake = await startFake({ scenario: 'json-schema-only', script: [ccReply('{"kind":"final","text":"ok"}')] });
  const adapter = makeAdapter(fake, {
    toolCalling: () => 'constrained',
    keywordSupport: () => ALL_KEYWORDS,
    capabilities: async () => capabilities,
  });
  const { error } = await collect(adapter, ccRequest(toolChoice));
  return { error: error as any, fake };
};

const chatRequestCount = (fake: { requests: Array<{ path: string }> }): number =>
  fake.requests.filter((request) => request.path === '/v1/chat/completions').length;

const listedNames = (body: any): string[] => (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);

const envelopeValidator = (body: any) => new Ajv2020.default({ strict: false }).compile(body.response_format.json_schema.schema as object);

const callOf = (name: string) => ({ kind: 'tool_calls', calls: [{ name, arguments: {} }] });
const FINAL = { kind: 'final', text: 'done' };

const systemText = (body: any): string =>
  body.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');

const expectNamedRefusal = (error: any, target: string) => {
  expect(error).toBeDefined();
  expect(error.param).toBe('tool_choice');
  expect(String(error.message)).toContain('allowed_tools');
  expect(String(error.message)).toContain(target);
};

const CC_NATIVE = withAllowedTools({ ...CC_CAPABILITIES, toolCalling: 'native' }, ['native']);
const CC_CONSTRAINED = withAllowedTools({ ...CC_CAPABILITIES, toolCalling: 'constrained' }, ['envelope']);

describe('chat-completions native: the declared native form {type:"allowed_tools", allowed_tools:{mode, tools}} (not verified against OpenAI)', () => {
  const nativeChoice = (mode: string, names: readonly string[]) => ({
    type: 'allowed_tools',
    allowed_tools: { mode, tools: names.map((name) => ({ type: 'function', function: { name } })) },
  });

  it('sends the declared native form with mode required for 2 of 3 tools and keeps all 3 tools listed', async () => {
    const { error, fake } = await ccNativeSent(CC_NATIVE, TWO_REQUIRED);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toEqual(nativeChoice('required', ['alpha', 'beta']));
  });

  it('sends the declared native form with mode auto for 2 of 3 tools', async () => {
    const { error, fake } = await ccNativeSent(CC_NATIVE, TWO_AUTO);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toEqual(nativeChoice('auto', ['alpha', 'beta']));
  });

  it('sends mode auto in the declared native form when the request omits mode', async () => {
    const { error, fake } = await ccNativeSent(CC_NATIVE, TWO_NO_MODE);
    expect(error).toBeUndefined();
    expect(lastCompletionBody(fake).tool_choice).toEqual(nativeChoice('auto', ['alpha', 'beta']));
  });

  it('sends tool_choice none with all 3 tools listed for an allowed set with mode none', async () => {
    const { error, fake } = await ccNativeSent(CC_NATIVE, TWO_NONE);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toBe('none');
  });

  it('sends the declared native form with mode required for a set of one', async () => {
    const { error, fake } = await ccNativeSent(CC_NATIVE, ONE_REQUIRED);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toEqual(nativeChoice('required', ['alpha']));
  });
});

describe('chat-completions constrained: the envelope over the allowed subset, with every tool listed', () => {
  it('lists all 3 tools and lets the required envelope call only alpha or beta', async () => {
    const { error, fake } = await ccConstrainedSent(CC_CONSTRAINED, TWO_REQUIRED);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    for (const name of ALL_NAMES) expect(systemText(body)).toContain(`"name":"${name}"`);
    const validate = envelopeValidator(body);
    expect(validate(callOf('alpha'))).toBe(true);
    expect(validate(callOf('beta'))).toBe(true);
    expect(validate(callOf('gamma'))).toBe(false);
    expect(validate(FINAL)).toBe(false);
  });

  it('lists all 3 tools and lets the auto envelope answer or call alpha or beta, never gamma', async () => {
    const { error, fake } = await ccConstrainedSent(CC_CONSTRAINED, TWO_AUTO);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    for (const name of ALL_NAMES) expect(systemText(body)).toContain(`"name":"${name}"`);
    const validate = envelopeValidator(body);
    expect(validate(FINAL)).toBe(true);
    expect(validate(callOf('alpha'))).toBe(true);
    expect(validate(callOf('beta'))).toBe(true);
    expect(validate(callOf('gamma'))).toBe(false);
  });

  it('sends no envelope for an allowed set with mode none, as for tool_choice none', async () => {
    const { error, fake } = await ccConstrainedSent(CC_CONSTRAINED, TWO_NONE);
    expect(error).toBeUndefined();
    expect('response_format' in lastCompletionBody(fake)).toBe(false);
  });

  it('lists all 3 tools and lets the envelope for a required set of one call only alpha', async () => {
    const { error, fake } = await ccConstrainedSent(CC_CONSTRAINED, ONE_REQUIRED);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    for (const name of ALL_NAMES) expect(systemText(body)).toContain(`"name":"${name}"`);
    const validate = envelopeValidator(body);
    expect(validate(callOf('alpha'))).toBe(true);
    expect(validate(callOf('beta'))).toBe(false);
    expect(validate(FINAL)).toBe(false);
  });
});

describe('anthropic declaring forced single tool and filtered tools: the stable form first, filtering last', () => {
  const ANTHROPIC = withAllowedTools(REMOTE_CAPABILITIES, ['filter', 'single_tool']);

  const sentBody = async (toolChoice: unknown): Promise<any> => {
    const gateway = await startAnthropicGateway({ capabilities: ANTHROPIC, script: [anthropicTextReply(['ok'])] });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hello'), tools: TOOLS, tool_choice: toolChoice }),
    );
    expect(response.status).toBe(200);
    return gateway.fake.requests[0]?.body;
  };

  it('filters the tools to alpha and beta with tool_choice any for 2 of 3 required', async () => {
    const body = await sentBody(TWO_REQUIRED);
    expect(listedNames(body)).toEqual(['alpha', 'beta']);
    expect(body.tool_choice).toEqual({ type: 'any' });
  });

  it('filters the tools to alpha and beta with tool_choice auto for 2 of 3 auto', async () => {
    const body = await sentBody(TWO_AUTO);
    expect(listedNames(body)).toEqual(['alpha', 'beta']);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('keeps all 3 tools with tool_choice none for an allowed set with mode none', async () => {
    const body = await sentBody(TWO_NONE);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toEqual({ type: 'none' });
  });

  it('keeps all 3 tools and forces alpha for a required set of one, whatever the declared order', async () => {
    const body = await sentBody(ONE_REQUIRED);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'alpha' });
  });
});

describe('ollama declaring filtered tools: a named refusal where the form cannot express required', () => {
  const OLLAMA_FILTER = withAllowedTools(OLLAMA_CAPABILITIES, ['filter']);

  const run = async (toolChoice: unknown, capabilities: Capabilities = OLLAMA_FILTER) => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const request = { model: 'devstral-small-2', input: [userText('hello')], tools: TOOLS, tool_choice: toolChoice } as AdapterRequest;
    const { error } = await collectOllama(makeOllamaAdapter(fake, { capabilities: async () => capabilities }), request);
    return { error: error as any, bodies: fake.chatBodies() as any[] };
  };

  it('refuses 2 of 3 required with an error naming allowed_tools and the target, without calling the server', async () => {
    const { error, bodies } = await run(TWO_REQUIRED);
    expectNamedRefusal(error, 'local');
    expect(bodies).toHaveLength(0);
  });

  it('sends only alpha and beta for 2 of 3 auto', async () => {
    const { error, bodies } = await run(TWO_AUTO);
    expect(error).toBeUndefined();
    expect(listedNames(bodies[0])).toEqual(['alpha', 'beta']);
  });

  it('sends no tools for an allowed set with mode none, as for tool_choice none', async () => {
    const { error, bodies } = await run(TWO_NONE);
    expect(error).toBeUndefined();
    expect('tools' in bodies[0]).toBe(false);
  });

  it('refuses a required set of one with an error naming allowed_tools and the target, without calling the server', async () => {
    const { error, bodies } = await run(ONE_REQUIRED);
    expectNamedRefusal(error, 'local');
    expect(bodies).toHaveLength(0);
  });
});

describe('open-responses declaring the native allowed set: forwarded with a concrete mode', () => {
  const OPEN_NATIVE = withAllowedTools(REMOTE_CAPABILITIES, ['native']);

  const sentBody = async (toolChoice: unknown): Promise<any> => {
    const gateway = await startOpenResponsesGateway({ capabilities: OPEN_NATIVE, script: [openResponsesTextReply(['ok'])] });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hello'), tools: TOOLS, tool_choice: toolChoice }),
    );
    expect(response.status).toBe(200);
    return gateway.fake.requests[0]?.body;
  };

  it('forwards 2 of 3 required with all 3 tools listed', async () => {
    const body = await sentBody(TWO_REQUIRED);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toEqual(allowed(['alpha', 'beta'], 'required'));
  });

  it('forwards 2 of 3 auto', async () => {
    expect((await sentBody(TWO_AUTO)).tool_choice).toEqual(allowed(['alpha', 'beta'], 'auto'));
  });

  it('forwards an omitted mode as mode auto', async () => {
    expect((await sentBody(TWO_NO_MODE)).tool_choice).toEqual(allowed(['alpha', 'beta'], 'auto'));
  });

  it('sends tool_choice none with all 3 tools listed for an allowed set with mode none', async () => {
    const body = await sentBody(TWO_NONE);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toBe('none');
  });

  it('forwards a required set of one', async () => {
    expect((await sentBody(ONE_REQUIRED)).tool_choice).toEqual(allowed(['alpha'], 'required'));
  });
});

describe('the form comes from declared capability data, never from the target name', () => {
  it('answers 400 naming allowed_tools and the target when an open-responses target declares no form', async () => {
    const gateway = await startOpenResponsesGateway({ capabilities: REMOTE_CAPABILITIES, script: [openResponsesTextReply(['ok'])] });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hello'), tools: TOOLS, tool_choice: TWO_AUTO }),
    );
    expect(response.status).toBe(400);
    expectNamedRefusal(response.body.error, 'remote');
    expect(gateway.fake.requests).toHaveLength(0);
  });

  it('refuses with an error naming allowed_tools and the target when a chat-completions target declares no form', async () => {
    const { error, fake } = await ccNativeSent({ ...CC_CAPABILITIES, toolCalling: 'native' }, TWO_AUTO);
    expectNamedRefusal(error, 'fm');
    expect(chatRequestCount(fake)).toBe(0);
  });

  it('refuses with an error naming allowed_tools and the target when an ollama target declares no form', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const request = { model: 'devstral-small-2', input: [userText('hello')], tools: TOOLS, tool_choice: TWO_AUTO } as AdapterRequest;
    const { error } = await collectOllama(makeOllamaAdapter(fake), request);
    expectNamedRefusal(error, 'local');
    expect(fake.chatBodies()).toHaveLength(0);
  });
});

describe('one validation for /v1/responses and /v1/momonga/count_tokens', () => {
  const ANTHROPIC = withAllowedTools(REMOTE_CAPABILITIES, ['single_tool', 'filter']);

  const post = (gateway: UpstreamGateway, path: string, toolChoice: unknown) =>
    postJson(gateway.client, path, { model: 'fast', input: userInput('hello'), tools: TOOLS, tool_choice: toolChoice }).then(readJson);

  const countingGateway = () => startAnthropicGateway({ capabilities: ANTHROPIC, script: [anthropicCountTokensReply(42)] });
  const creatingGateway = () => startAnthropicGateway({ capabilities: ANTHROPIC, script: [anthropicTextReply(['ok'])] });

  it('accepts an allowed set at count_tokens as at create', async () => {
    const counting = await countingGateway();
    const creating = await creatingGateway();
    const counted = await post(counting, '/v1/momonga/count_tokens', TWO_AUTO);
    const created = await post(creating, '/v1/responses', TWO_AUTO);
    expect(created.status).toBe(200);
    expect(counted.status).toBe(200);
    expect(counted.body.input_tokens).toBe(42);
  });

  it('refuses an allowed name that is not among the declared tools with the same 400 at both endpoints', async () => {
    const counting = await countingGateway();
    const creating = await creatingGateway();
    const undeclared = allowed(['alpha', 'zeta'], 'auto');
    const created = await post(creating, '/v1/responses', undeclared);
    const counted = await post(counting, '/v1/momonga/count_tokens', undeclared);
    expect(created.status).toBe(400);
    expect(created.body.error.type).toBe('invalid_request');
    expect(String(created.body.error.message)).toContain('zeta');
    expect(counted.status).toBe(400);
    expect(counted.body).toEqual(created.body);
    expect(creating.fake.requests).toHaveLength(0);
    expect(counting.fake.requests).toHaveLength(0);
  });
});

describe('the response echoes tool_choice with a concrete mode', () => {
  it('echoes mode auto for a request that omits mode', async () => {
    const gateway = await startOpenResponsesGateway({
      capabilities: withAllowedTools(REMOTE_CAPABILITIES, ['native']),
      script: [openResponsesTextReply(['ok'])],
    });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hello'), tools: TOOLS, tool_choice: TWO_NO_MODE }),
    );
    expect(response.status).toBe(200);
    expect(response.body.tool_choice).toEqual(allowed(['alpha', 'beta'], 'auto'));
  });
});
