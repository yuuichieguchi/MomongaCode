import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { AdapterRequest, Capabilities } from '@momonga/protocol';
import { anthropicCountTokensReply, anthropicTextReply, openResponsesTextReply } from '@momonga/testkit';
import path from 'node:path';
import { createReplayAdapter } from './support/replay-adapter.ts';
import { makeDir, postJson, readJson, readSse, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, collect, lastCompletionBody, makeAdapter, startFake, userText } from './cc-support.ts';
import { OLLAMA_CAPABILITIES, chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway, startOpenResponsesGateway } from './upstream-gateway-support.ts';
import type { UpstreamGateway } from './upstream-gateway-support.ts';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { TARGET } from './cc-support.ts';
import { wireOf } from '../src/adapters/chat-completions/wire.ts';
import { createRequestValidator } from '../src/core/validation.ts';

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
  const adapter = makeAdapter(fake, { capabilities: async () => capabilities });
  const { error } = await collect(adapter, ccRequest(toolChoice));
  return { error: error as any, fake };
};

const ccConstrainedSent = async (capabilities: Capabilities, toolChoice: unknown, keywords = ALL_KEYWORDS) => {
  const fake = await startFake({ scenario: 'json-schema-only', script: [ccReply('{"kind":"final","text":"ok"}')] });
  const adapter = makeAdapter(fake, {
    keywordSupport: () => keywords,
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
  expect(error.code).toBe('unsupported_tool_choice');
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
      await postJson(gateway.client, '/v1/responses', { model: gateway.model, input: userInput('hello'), tools: TOOLS, tool_choice: toolChoice }),
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
      await postJson(gateway.client, '/v1/responses', { model: gateway.model, input: userInput('hello'), tools: TOOLS, tool_choice: toolChoice }),
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
      await postJson(gateway.client, '/v1/responses', { model: gateway.model, input: userInput('hello'), tools: TOOLS, tool_choice: TWO_AUTO }),
    );
    expect(response.status).toBe(400);
    expectNamedRefusal(response.body.error, 'upstream-model');
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
    postJson(gateway.client, path, { model: gateway.model, input: userInput('hello'), tools: TOOLS, tool_choice: toolChoice }).then(readJson);

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
      await postJson(gateway.client, '/v1/responses', { model: gateway.model, input: userInput('hello'), tools: TOOLS, tool_choice: TWO_NO_MODE }),
    );
    expect(response.status).toBe(200);
    expect(response.body.tool_choice).toEqual(allowed(['alpha', 'beta'], 'auto'));
  });
});

describe('count what is sent: the count body carries the create body tools and tool_choice', () => {
  const sentAndCounted = async (capabilities: Capabilities, toolChoice: unknown) => {
    const creating = await startAnthropicGateway({ capabilities, script: [anthropicTextReply(['ok'])] });
    const counting = await startAnthropicGateway({ capabilities, script: [anthropicCountTokensReply(42)] });
    const body = { model: creating.model, input: userInput('hello'), tools: TOOLS, tool_choice: toolChoice };
    const created = await readJson(await postJson(creating.client, '/v1/responses', body));
    const counted = await readJson(await postJson(counting.client, '/v1/momonga/count_tokens', body));
    expect(created.status).toBe(200);
    expect(counted.status).toBe(200);
    const sent = creating.fake.requests[0]?.body as any;
    const count = counting.fake.requests[0]?.body as any;
    expect(counting.fake.requests[0]?.path).toBe('/v1/messages/count_tokens');
    return { sent, count };
  };

  const expectSameChoice = ({ sent, count }: { sent: any; count: any }) => {
    expect(count.tools).toEqual(sent.tools);
    expect(count.tool_choice).toEqual(sent.tool_choice);
  };

  it('anthropic filter form over a subset: counted with the filtered tools and the choice sent', async () => {
    const pair = await sentAndCounted(withAllowedTools(REMOTE_CAPABILITIES, ['filter']), TWO_AUTO);
    expect(listedNames(pair.sent)).toEqual(['alpha', 'beta']);
    expectSameChoice(pair);
  });

  it('anthropic single_tool form for a required set of one: counted with the forced tool', async () => {
    const pair = await sentAndCounted(withAllowedTools(REMOTE_CAPABILITIES, ['single_tool']), ONE_REQUIRED);
    expect(pair.sent.tool_choice).toEqual({ type: 'tool', name: 'alpha' });
    expectSameChoice(pair);
  });

  it('anthropic plain required: counted with tool_choice any', async () => {
    const pair = await sentAndCounted(REMOTE_CAPABILITIES, 'required');
    expect(pair.sent.tool_choice).toEqual({ type: 'any' });
    expectSameChoice(pair);
  });

  it('anthropic plain none: counted with tool_choice none', async () => {
    const pair = await sentAndCounted(REMOTE_CAPABILITIES, 'none');
    expect(pair.sent.tool_choice).toEqual({ type: 'none' });
    expectSameChoice(pair);
  });

  it('chat-completions renderWire for the filter form renders the tools the create body sends', async () => {
    const capabilities = withAllowedTools({ ...CC_CAPABILITIES, toolCalling: 'native' }, ['filter']);
    const fake = await startFake({ scenario: 'tools-ok', script: [ccReply('ok')] });
    const adapter = makeAdapter(fake, { capabilities: async () => capabilities });
    const { error } = await collect(adapter, ccRequest(TWO_AUTO));
    expect(error).toBeUndefined();
    const sent = lastCompletionBody(fake);
    expect(listedNames(sent)).toEqual(['alpha', 'beta']);
    const rendered = adapter.renderWire?.(ccRequest(TWO_AUTO), TARGET, { reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities });
    expect(rendered).toEqual(wireOf(sent));
  });
});

describe('filter on the constrained path: the allowed tools alone in the listing and the envelope', () => {
  it('a constrained target declaring only filter lists and admits exactly the allowed tools', async () => {
    const { error, fake } = await ccConstrainedSent(withAllowedTools({ ...CC_CAPABILITIES, toolCalling: 'constrained' }, ['filter']), TWO_AUTO);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(systemText(body)).toContain('"name":"alpha"');
    expect(systemText(body)).toContain('"name":"beta"');
    expect(systemText(body)).not.toContain('"name":"gamma"');
    const validate = envelopeValidator(body);
    expect(validate(callOf('alpha'))).toBe(true);
    expect(validate(callOf('beta'))).toBe(true);
    expect(validate(callOf('gamma'))).toBe(false);
  });

  it('a constrained target declaring filter and envelope keeps every tool listed and restricts by the envelope', async () => {
    const { error, fake } = await ccConstrainedSent(withAllowedTools({ ...CC_CAPABILITIES, toolCalling: 'constrained' }, ['filter', 'envelope']), TWO_AUTO);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    for (const name of ALL_NAMES) expect(systemText(body)).toContain(`"name":"${name}"`);
    const validate = envelopeValidator(body);
    expect(validate(callOf('alpha'))).toBe(true);
    expect(validate(callOf('gamma'))).toBe(false);
  });
});

describe('an allowed set equal to the request tools is the plain mode, on a target that declares no form', () => {
  const ALL_AUTO = allowed(ALL_NAMES, 'auto');
  const ALL_REQUIRED = allowed(ALL_NAMES, 'required');

  it('chat-completions native sends plain auto with every tool', async () => {
    const { error, fake } = await ccNativeSent({ ...CC_CAPABILITIES, toolCalling: 'native' }, ALL_AUTO);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toBe('auto');
  });

  it('chat-completions native sends plain required with every tool', async () => {
    const { error, fake } = await ccNativeSent({ ...CC_CAPABILITIES, toolCalling: 'native' }, ALL_REQUIRED);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toBe('required');
  });

  it('anthropic sends plain auto through the gateway and echoes the request as given', async () => {
    const gateway = await startAnthropicGateway({ capabilities: REMOTE_CAPABILITIES, script: [anthropicTextReply(['ok'])] });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: gateway.model, input: userInput('hello'), tools: TOOLS, tool_choice: ALL_AUTO }),
    );
    expect(response.status).toBe(200);
    const body = gateway.fake.requests[0]?.body as any;
    expect(listedNames(body)).toEqual(ALL_NAMES);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(response.body.tool_choice).toEqual(ALL_AUTO);
  });

  it('anthropic sends plain required as tool_choice any', async () => {
    const gateway = await startAnthropicGateway({ capabilities: REMOTE_CAPABILITIES, script: [anthropicTextReply(['ok'])] });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses', { model: gateway.model, input: userInput('hello'), tools: TOOLS, tool_choice: ALL_REQUIRED }),
    );
    expect(response.status).toBe(200);
    expect((gateway.fake.requests[0]?.body as any).tool_choice).toEqual({ type: 'any' });
  });

  it('ollama sends every tool for an allowed set of every tool with auto', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const request = { model: 'devstral-small-2', input: [userText('hello')], tools: TOOLS, tool_choice: ALL_AUTO } as AdapterRequest;
    const { error } = await collectOllama(makeOllamaAdapter(fake), request);
    expect(error).toBeUndefined();
    expect(listedNames(fake.chatBodies()[0])).toEqual(ALL_NAMES);
  });
});

const SUBSET_TOOLS = [toolNamed('alpha'), toolNamed('beta')];

const countBodyFor = (model: string, tools: unknown, toolChoice: unknown) => ({ model, input: userInput('hello'), tools, tool_choice: toolChoice });
const countBody = (tools: unknown, toolChoice: unknown) => countBodyFor('scripted/devstral-small-2', tools, toolChoice);

const startOllamaGateway = async (capabilities: Capabilities) => {
  const fake = await startFakeOllama({ chat: [{ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
  const adapter = makeOllamaAdapter(fake, { capabilities: async () => capabilities });
  return startGateway({
    adapters: { 'scripted/devstral-small-2': adapter },
    config: { chains: { 'scripted/devstral-small-2': ['scripted/devstral-small-2'] }, targets: { 'scripted/devstral-small-2': { kind: 'local' } } },
  });
};

describe('count what is sent on adapters that count by estimate', () => {
  it('ollama with the filter form counts the allowed tools that create sends, not every tool', async () => {
    const gateway = await startOllamaGateway(withAllowedTools(OLLAMA_CAPABILITIES, ['filter']));
    const filtered = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', countBodyFor(gateway.model, TOOLS, TWO_AUTO)));
    const subset = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', countBodyFor(gateway.model, SUBSET_TOOLS, 'auto')));
    expect(filtered.status).toBe(200);
    expect(subset.status).toBe(200);
    expect(filtered.body.input_tokens).toBe(subset.body.input_tokens);
  });

  it('open-responses with the filter form counts the allowed tools that create sends, not every tool', async () => {
    const gateway = await startOpenResponsesGateway({ capabilities: withAllowedTools(REMOTE_CAPABILITIES, ['filter']), script: [] });
    const filtered = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', countBodyFor(gateway.model, TOOLS, TWO_AUTO)));
    const subset = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', countBodyFor(gateway.model, SUBSET_TOOLS, 'auto')));
    expect(filtered.status).toBe(200);
    expect(subset.status).toBe(200);
    expect(filtered.body.input_tokens).toBe(subset.body.input_tokens);
  });
});

describe('a replay adapter in record mode carries the wire of the adapter it wraps', () => {
  it('counts a filter-form subset with the tools that create sends, and both succeed', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const inner = makeOllamaAdapter(fake, { capabilities: async () => withAllowedTools(OLLAMA_CAPABILITIES, ['filter']) });
    const recorder = createReplayAdapter({ path: path.join(makeDir(), 'recording.jsonl'), mode: 'record', inner });
    const gateway = await startGateway({
      adapters: { 'scripted/devstral-small-2': recorder },
      config: { chains: { 'scripted/devstral-small-2': ['scripted/devstral-small-2'] }, targets: { 'scripted/devstral-small-2': { kind: 'local' } } },
    });
    const created = await readJson(await postJson(gateway.client, '/v1/responses', countBodyFor(gateway.model, TOOLS, TWO_AUTO)));
    expect(created.status).toBe(200);
    expect(listedNames(fake.chatBodies()[0])).toEqual(['alpha', 'beta']);
    const filtered = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', countBodyFor(gateway.model, TOOLS, TWO_AUTO)));
    const subset = await readJson(await postJson(gateway.client, '/v1/momonga/count_tokens', countBodyFor(gateway.model, SUBSET_TOOLS, 'auto')));
    expect(filtered.status).toBe(200);
    expect(subset.status).toBe(200);
    expect(filtered.body.input_tokens).toBe(subset.body.input_tokens);
  });
});

describe('a form the target cannot express on this request is not chosen', () => {
  const NO_LITERALS = { ...ALL_KEYWORDS, const: false, enum: false };
  const constrained = (forms: readonly string[]) => withAllowedTools({ ...CC_CAPABILITIES, toolCalling: 'constrained' }, forms);

  it('a constrained target without const or enum falls through from envelope to filter', async () => {
    const { error, fake } = await ccConstrainedSent(constrained(['envelope', 'filter']), TWO_AUTO, NO_LITERALS);
    expect(error).toBeUndefined();
    const body = lastCompletionBody(fake);
    expect(systemText(body)).toContain('"name":"alpha"');
    expect(systemText(body)).toContain('"name":"beta"');
    expect(systemText(body)).not.toContain('"name":"gamma"');
  });

  it('a constrained target without const or enum declaring only envelope is refused with the standard message', async () => {
    const { error, fake } = await ccConstrainedSent(constrained(['envelope']), TWO_AUTO, NO_LITERALS);
    expectNamedRefusal(error, 'fm');
    expect(chatRequestCount(fake)).toBe(0);
  });
});

describe('ollama with every tool allowed and required', () => {
  it('is refused with the standard allowed_tools message, not the plain-choice message', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const request = { model: 'devstral-small-2', input: [userText('hello')], tools: TOOLS, tool_choice: allowed(ALL_NAMES, 'required') } as AdapterRequest;
    const { error } = await collectOllama(makeOllamaAdapter(fake), request);
    expectNamedRefusal(error, 'local');
    expect(fake.chatBodies()).toHaveLength(0);
  });
});

describe('one validation of the allowed-set size for create and count_tokens', () => {
  it('refuses 129 entries with the same 400 at both endpoints', async () => {
    const tooMany = allowed(Array.from({ length: 129 }, () => 'alpha'), 'auto');
    const creating = await startAnthropicGateway({ capabilities: REMOTE_CAPABILITIES, script: [anthropicTextReply(['ok'])] });
    const counting = await startAnthropicGateway({ capabilities: REMOTE_CAPABILITIES, script: [anthropicCountTokensReply(42)] });
    const created = await readJson(await postJson(creating.client, '/v1/responses', countBodyFor(creating.model, TOOLS, tooMany)));
    const counted = await readJson(await postJson(counting.client, '/v1/momonga/count_tokens', countBodyFor(counting.model, TOOLS, tooMany)));
    expect(created.status).toBe(400);
    expect(counted.status).toBe(400);
    expect(created.body.error.param).toBe('tool_choice.tools');
    expect(String(created.body.error.message)).toContain('128');
    expect(counted.body).toEqual(created.body);
    expect(counting.fake.requests).toHaveLength(0);
  });
});

describe('the request validator maps an oversized allowed set to its own oneOf branch', () => {
  const thrownBy = (parse: () => unknown): any => {
    try {
      parse();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('reports tool_choice.tools and the 128-item limit for create and count_tokens alike', () => {
    const validator = createRequestValidator();
    const body = { model: 'scripted/devstral-small-2', input: 'hello', tools: TOOLS, tool_choice: allowed(Array.from({ length: 129 }, () => 'alpha'), 'auto') };
    const fromCreate = thrownBy(() => validator.parseCreate(body));
    const fromCount = thrownBy(() => validator.parseCountTokens(body));
    expect(fromCreate?.body?.param).toBe('tool_choice.tools');
    expect(String(fromCreate?.body?.message)).toContain('128');
    expect(fromCount?.body).toEqual(fromCreate?.body);
  });
});

describe('duplicate allowed names count once', () => {
  it('a set naming every tool with duplicates is plain auto on a target that declares no form', async () => {
    const { error, fake } = await ccNativeSent({ ...CC_CAPABILITIES, toolCalling: 'native' }, allowed(['alpha', 'alpha', 'beta', 'gamma', 'beta'], 'auto'));
    expect(error).toBeUndefined();
    expect(lastCompletionBody(fake).tool_choice).toBe('auto');
  });

  it('a required set naming one tool twice forces that tool through single_tool', async () => {
    const gateway = await startAnthropicGateway({ capabilities: withAllowedTools(REMOTE_CAPABILITIES, ['single_tool']), script: [anthropicTextReply(['ok'])] });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', countBodyFor(gateway.model, TOOLS, allowed(['alpha', 'alpha'], 'required'))));
    expect(response.status).toBe(200);
    expect((gateway.fake.requests[0]?.body as any).tool_choice).toEqual({ type: 'tool', name: 'alpha' });
  });
});

describe('the streaming echo carries a concrete mode', () => {
  it('echoes mode auto in response.created and the terminal event for a request that omits mode', async () => {
    const gateway = await startOpenResponsesGateway({ capabilities: withAllowedTools(REMOTE_CAPABILITIES, ['native']), script: [openResponsesTextReply(['ok'])] });
    const frames = await readSse(await postJson(gateway.client, '/v1/responses', { ...countBodyFor(gateway.model, TOOLS, TWO_NO_MODE), stream: true }));
    const withResource = frames.filter((frame) => frame.data?.response !== undefined);
    expect(withResource.length).toBeGreaterThan(1);
    for (const frame of withResource) expect(frame.data.response.tool_choice).toEqual(allowed(['alpha', 'beta'], 'auto'));
  });
});
