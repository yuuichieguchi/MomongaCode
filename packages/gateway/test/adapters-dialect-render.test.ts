import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/gateway';
import type { AdapterRequest, AdapterTarget, Capabilities, StreamEvent } from '@momonga/protocol';
import { anthropicTextReply, createFakeClock, openResponsesTextReply, startFakeAnthropic, startFakeOpenResponses } from '@momonga/testkit';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { CC_CAPABILITIES, collect, completionBodies, lastCompletionBody, makeAdapter, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';
import { chunkLine, doneLine, makeOllamaAdapter, OLLAMA_CAPABILITIES, startFakeOllama } from './ollama-support.ts';
import { contextOf } from './own-reasoning.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const EDIT_PARAMETERS = { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } }, required: ['path'] };

const EDIT_STRICT_CLOSED = {
  type: 'object',
  properties: { path: { type: 'string' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  required: ['path', 'note'],
  additionalProperties: false,
};

const toolRequest = (name: string, parameters: Record<string, unknown>): AdapterRequest => ({
  model: 'm',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  tools: [{ type: 'function', name, description: 'A tool', parameters }],
});

const withDialect = (base: Capabilities, schemaDialect: string): Capabilities => ({ ...base, schemaDialect });

const drain = async (adapter: ProviderAdapter, target: AdapterTarget, request: AdapterRequest): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of adapter.create(request, await contextOf(adapter, target))) events.push(event);
  return events;
};

describe('every adapter sends tool parameters rendered in the dialect of the target', () => {
  it('chat-completions native sends the strict-closed rendering', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
    const adapter = makeAdapter(fake, { schemaDialect: () => 'strict-closed', capabilities: async () => withDialect(CC_CAPABILITIES, 'strict-closed') });
    const { error } = await collect(adapter, toolRequest('edit', EDIT_PARAMETERS));
    expect(error).toBeUndefined();
    expect(lastCompletionBody(fake).tools[0].function.parameters).toEqual(EDIT_STRICT_CLOSED);
  });

  it('anthropic sends the strict-closed rendering as input_schema', async () => {
    const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: [anthropicTextReply(['ok'])] });
    registerCleanup(() => fake.close());
    const adapter = createAnthropicAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      apiKey: async () => FAKE_API_KEY,
      capabilities: async () => withDialect(REMOTE_CAPABILITIES, 'strict-closed'),
      clock: createFakeClock(START_MS),
      apiVersion: '2026-10-21',
    });
    registerCleanup(() => adapter.close());
    await drain(adapter, { name: 'remote', model: 'claude-fake' }, toolRequest('edit', EDIT_PARAMETERS));
    expect((fake.requests.at(-1)?.body as any).tools[0].input_schema).toEqual(EDIT_STRICT_CLOSED);
  });

  it('ollama sends the strict-closed rendering as function parameters', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines: [chunkLine({ role: 'assistant', content: 'ok' }), doneLine()] }] });
    const adapter = makeOllamaAdapter(fake, { capabilities: async () => withDialect(OLLAMA_CAPABILITIES, 'strict-closed') });
    await drain(adapter, { name: 'local', model: 'devstral-small-2' }, toolRequest('edit', EDIT_PARAMETERS));
    expect(fake.chatBodies().at(-1).tools[0].function.parameters).toEqual(EDIT_STRICT_CLOSED);
  });

  it('open-responses sends the strict-closed rendering as tool parameters', async () => {
    const fake = await startFakeOpenResponses({ script: [openResponsesTextReply(['ok'])] });
    registerCleanup(() => fake.close());
    const adapter = createOpenResponsesAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      capabilities: async () => withDialect(REMOTE_CAPABILITIES, 'strict-closed'),
      clock: createFakeClock(START_MS),
    });
    registerCleanup(() => adapter.close());
    await drain(adapter, { name: 'remote', model: 'gpt-fake' }, toolRequest('edit', EDIT_PARAMETERS));
    expect((fake.requests.at(-1)?.body as any).tools[0].parameters).toEqual(EDIT_STRICT_CLOSED);
  });

  it('a render failure names the tool and sends nothing', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
    const adapter = makeAdapter(fake, { schemaDialect: () => 'strict-closed', capabilities: async () => withDialect(CC_CAPABILITIES, 'strict-closed') });
    const { error } = await collect(adapter, toolRequest('pick', { type: 'object', properties: { a: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } }));
    expect(error).toMatchObject({ code: 'unsupported_tool_schema', reason: 'reject', tool: 'pick', path: '/properties/a' });
    expect(completionBodies(fake)).toEqual([]);
  });
});

describe('the construct-table getter of the chat-completions adapter (decision e (iii))', () => {
  const REF_PARAMETERS = { type: 'object', properties: { r: { $ref: '#/$defs/d' } }, $defs: { d: { type: 'string' } } };

  it('fails a tool whose $ref the table records refused before any request, naming the tool and the path', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
    const adapter = makeAdapter(fake, { constructSupport: () => ({ ref: 'refused', typeArray: 'accepted', mixedEnum: 'accepted' }) });
    const { error } = await collect(adapter, toolRequest('fetch', REF_PARAMETERS));
    expect(error).toMatchObject({ code: 'unsupported_tool_schema', reason: 'construct', tool: 'fetch', path: '/properties/r' });
    expect(completionBodies(fake)).toEqual([]);
  });

  it('fails the same tool in constrained mode before any request', async () => {
    const fake = await startFake({ scenario: 'json-schema-only', script: [textReply('ok')] });
    const adapter = makeAdapter(fake, { constructSupport: () => ({ ref: 'refused', typeArray: 'accepted', mixedEnum: 'accepted' }) }, 'constrained');
    const { error } = await collect(adapter, toolRequest('fetch', REF_PARAMETERS));
    expect(error).toMatchObject({ code: 'unsupported_tool_schema', reason: 'construct', tool: 'fetch' });
    expect(completionBodies(fake)).toEqual([]);
  });

  it('checks nothing without the getter, and the $ref goes out unchanged', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
    const adapter = makeAdapter(fake);
    const { error } = await collect(adapter, toolRequest('fetch', REF_PARAMETERS));
    expect(error).toBeUndefined();
    expect(lastCompletionBody(fake).tools[0].function.parameters).toEqual(REF_PARAMETERS);
  });
});

describe('the narrowings of the render reach the response (decision a)', () => {
  const FREE_FORM = { type: 'object', properties: { options: { type: 'object' }, path: { type: 'string' } }, required: ['path'] };

  const terminalOf = (events: readonly StreamEvent[]) => {
    const terminal = events.at(-1);
    if (terminal?.type !== 'response.completed') throw new Error(`the stream ended with ${terminal?.type}`);
    return terminal.response as typeof terminal.response & { schemaNarrowings?: unknown };
  };

  it('carries the free-form object narrowing of explicit-keys on the terminal response', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
    const adapter = makeAdapter(fake, { schemaDialect: () => 'explicit-keys', capabilities: async () => withDialect(CC_CAPABILITIES, 'explicit-keys') });
    const { events, error } = await collect(adapter, toolRequest('configure', FREE_FORM));
    expect(error).toBeUndefined();
    expect(terminalOf(events).schemaNarrowings).toEqual([{ tool: 'configure', path: '/properties/options' }]);
  });

  it('carries no narrowing under json-schema-2020-12', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
    const adapter = makeAdapter(fake);
    const { events, error } = await collect(adapter, toolRequest('configure', FREE_FORM));
    expect(error).toBeUndefined();
    expect(terminalOf(events).schemaNarrowings).toBeUndefined();
  });
});
