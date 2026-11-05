import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/gateway';
import type { AdapterRequest, AdapterTarget, Capabilities, StreamEvent, WrapRecord } from '@momonga/protocol';
import { anthropicToolUseReply, createFakeClock, openResponsesToolCallReply, startFakeAnthropic, startFakeOpenResponses } from '@momonga/testkit';
import type { FakeScriptedReply } from '@momonga/testkit';
import { ResponseEmitter } from '../src/adapters/shared/response-emitter.ts';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { CC_CAPABILITIES, makeAdapter, startFake } from './cc-support.ts';
import { chunkLine, doneLine, makeOllamaAdapter, OLLAMA_CAPABILITIES, startFakeOllama } from './ollama-support.ts';
import { contextOf } from './own-reasoning.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const EDIT_RECORD: WrapRecord = { tool: 'edit', wrapped: [{ at: [], property: 'note' }] };
const VIEW_RECORD: WrapRecord = { tool: 'view', wrapped: [{ at: [], property: 'path' }] };

type EmitterOptions = ConstructorParameters<typeof ResponseEmitter>[0];

const emitterWith = (wraps: ReadonlyMap<string, WrapRecord> | undefined) => {
  const request: AdapterRequest = { model: 'm', input: [] };
  const options = { clock: createFakeClock(START_MS), model: 'm', request, ...(wraps === undefined ? {} : { wraps }) } as EmitterOptions;
  const emitter = new ResponseEmitter(options);
  emitter.start();
  emitter.take();
  return emitter;
};

const argumentDeltas = (events: readonly StreamEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'response.function_call_arguments.delta' ? [event.delta] : []));

const doneArguments = (events: readonly StreamEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'response.function_call_arguments.done' ? [event.arguments] : []));

const doneItemArguments = (events: readonly StreamEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'response.output_item.done' && event.item.type === 'function_call' ? [event.item.arguments] : []));

const streamCall = (emitter: ResponseEmitter, name: string, fragments: readonly string[]) => {
  emitter.beginCall(0, 'call_1', name);
  const whileOpen: StreamEvent[] = [...emitter.take()];
  for (const fragment of fragments) {
    emitter.appendCallArguments(0, fragment);
    whileOpen.push(...emitter.take());
  }
  emitter.completeCall(0);
  return { whileOpen, atClose: emitter.take() };
};

describe('the reply stage in ResponseEmitter', () => {
  const wraps = new Map([
    ['edit', EDIT_RECORD],
    ['view', VIEW_RECORD],
  ]);

  it('holds the deltas of a call whose name has a record and emits one inverted delta at close', () => {
    const { whileOpen, atClose } = streamCall(emitterWith(wraps), 'edit', ['{"path":"a.txt",', '"note":null}']);
    expect(argumentDeltas(whileOpen)).toEqual([]);
    expect(argumentDeltas(atClose)).toEqual(['{"path":"a.txt"}']);
    expect(doneArguments(atClose)).toEqual(['{"path":"a.txt"}']);
    expect(doneItemArguments(atClose)).toEqual(['{"path":"a.txt"}']);
  });

  it('never emits a delta carrying the recorded null', () => {
    const { whileOpen, atClose } = streamCall(emitterWith(wraps), 'edit', ['{"note":', 'null', ',"path":"b"}']);
    expect([...argumentDeltas(whileOpen), ...argumentDeltas(atClose)].join('')).not.toContain('null');
    expect(JSON.parse(doneArguments(atClose)[0] as string)).toEqual({ path: 'b' });
  });

  it('inverts by the record of the call name, so another tool with the same property name keeps its null', () => {
    const viewCall = streamCall(emitterWith(wraps), 'view', ['{"path":null,"note":null}']);
    expect(JSON.parse(doneArguments(viewCall.atClose)[0] as string)).toEqual({ note: null });
    const editCall = streamCall(emitterWith(wraps), 'edit', ['{"path":null,"note":null}']);
    expect(JSON.parse(doneArguments(editCall.atClose)[0] as string)).toEqual({ path: null });
  });

  it('passes a recorded call byte for byte when the recorded property is absent or not null', () => {
    const absent = streamCall(emitterWith(wraps), 'edit', ['{ "path" : "a.txt" }']);
    expect(doneArguments(absent.atClose)).toEqual(['{ "path" : "a.txt" }']);
    const present = streamCall(emitterWith(wraps), 'edit', ['{ "path" : "a.txt", "note" : "n" }']);
    expect(doneArguments(present.atClose)).toEqual(['{ "path" : "a.txt", "note" : "n" }']);
  });

  it('passes text that is not an object through unchanged', () => {
    const array = streamCall(emitterWith(wraps), 'edit', ['[1,', '2]']);
    expect(doneArguments(array.atClose)).toEqual(['[1,2]']);
    const broken = streamCall(emitterWith(wraps), 'edit', ['{"note":nu']);
    expect(doneArguments(broken.atClose)).toEqual(['{"note":nu']);
  });

  it('streams a call whose name has no record as today, byte for byte', () => {
    const { whileOpen, atClose } = streamCall(emitterWith(wraps), 'search', ['{"q":', 'null}']);
    expect(argumentDeltas(whileOpen)).toEqual(['{"q":', 'null}']);
    expect(doneArguments(atClose)).toEqual(['{"q":null}']);
  });

  it('changes nothing without a table', () => {
    const { whileOpen, atClose } = streamCall(emitterWith(undefined), 'edit', ['{"note":null}']);
    expect(argumentDeltas(whileOpen)).toEqual(['{"note":null}']);
    expect(doneArguments(atClose)).toEqual(['{"note":null}']);
  });
});

const STRICT_CLOSED = 'strict-closed';

type Tool = { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };

const EDIT_TOOL: Tool = {
  type: 'function',
  name: 'edit',
  description: 'Edit a file',
  parameters: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } }, required: ['path'] },
};

const LOOK_TOOL: Tool = {
  type: 'function',
  name: 'look',
  description: 'Look something up',
  parameters: { type: 'object', properties: { q: { type: ['string', 'null'] } } },
};

const requestFor = (tool: Tool): AdapterRequest => ({
  model: 'm',
  input: [{ type: 'message', role: 'user', content: `Use ${tool.name} now` }],
  tools: [tool],
});

type Reader = { kind: string; adapter: ProviderAdapter; target: AdapterTarget };

const strict = (base: Capabilities): Capabilities => ({ ...base, schemaDialect: STRICT_CLOSED });

const CC_TARGET: AdapterTarget = { name: 'fm', model: 'system' };

const ccNative = async (name: string, args: string): Promise<Reader> => {
  const reply: FakeScriptedReply = {
    kind: 'stream',
    chunks: [
      { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: args.slice(0, 5) } }] } },
      { delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } },
      { delta: {}, finishReason: 'tool_calls' },
    ],
  };
  const fake = await startFake({ scenario: 'tools-ok', script: [reply] });
  const adapter = makeAdapter(fake, { schemaDialect: () => STRICT_CLOSED, capabilities: async () => strict({ ...CC_CAPABILITIES, toolCalling: 'native' }) }, 'native');
  return { kind: 'chat-completions native', adapter, target: CC_TARGET };
};

const ccConstrained = async (name: string, args: string): Promise<Reader> => {
  const envelope = `{"kind":"tool_calls","calls":[{"name":"${name}","arguments":${args}}]}`;
  const reply: FakeScriptedReply = {
    kind: 'stream',
    chunks: [{ delta: { role: 'assistant', content: envelope.slice(0, 20) } }, { delta: { content: envelope.slice(20) } }, { delta: {}, finishReason: 'stop' }],
  };
  const fake = await startFake({ scenario: 'json-schema-only', script: [reply] });
  const adapter = makeAdapter(fake, { schemaDialect: () => STRICT_CLOSED, capabilities: async () => strict({ ...CC_CAPABILITIES, toolCalling: 'constrained' }) }, 'constrained');
  return { kind: 'chat-completions constrained', adapter, target: CC_TARGET };
};

const anthropic = async (name: string, args: string): Promise<Reader> => {
  const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: [anthropicToolUseReply('toolu_1', name, [args.slice(0, 7), args.slice(7)])] });
  registerCleanup(() => fake.close());
  const adapter = createAnthropicAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    apiKey: async () => FAKE_API_KEY,
    capabilities: async () => strict(REMOTE_CAPABILITIES),
    clock: createFakeClock(START_MS),
    apiVersion: '2026-10-21',
  });
  registerCleanup(() => adapter.close());
  return { kind: 'anthropic', adapter, target: { name: 'remote', model: 'claude-fake' } };
};

const ollama = async (name: string, args: string): Promise<Reader> => {
  const fake = await startFakeOllama({
    chat: [{ kind: 'ndjson', lines: [chunkLine({ role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { index: 0, name, arguments: JSON.parse(args) } }] }), doneLine()] }],
  });
  const adapter = makeOllamaAdapter(fake, { capabilities: async () => strict(OLLAMA_CAPABILITIES) });
  return { kind: 'ollama', adapter, target: { name: 'local', model: 'devstral-small-2' } };
};

const openResponses = async (name: string, args: string): Promise<Reader> => {
  const fake = await startFakeOpenResponses({ script: [openResponsesToolCallReply('call_1', name, [args.slice(0, 6), args.slice(6)])] });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => strict(REMOTE_CAPABILITIES),
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return { kind: 'open-responses', adapter, target: { name: 'remote', model: 'gpt-fake' } };
};

const READERS = [ccNative, ccConstrained, anthropic, ollama, openResponses];

const failedCall = (error: unknown): StreamEvent =>
  ({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: `the reader failed: ${String(error)}` } }) as unknown as StreamEvent;

const run = async (reader: Reader, request: AdapterRequest): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  try {
    for await (const event of reader.adapter.create(request, await contextOf(reader.adapter, reader.target))) events.push(event);
  } catch (error) {
    return [failedCall(error)];
  }
  return events;
};

const throughEveryReader = async (tool: Tool, args: string) => {
  const results: { kind: string; events: StreamEvent[] }[] = [];
  for (const start of READERS) {
    const reader = await start(tool.name, args);
    results.push({ kind: reader.kind, events: await run(reader, requestFor(tool)) });
  }
  return results;
};

describe('every adapter reader feeds the one reply stage', () => {
  it('gives the runtime identical inverted arguments from every reader for a wrapped optional property', async () => {
    const results = await throughEveryReader(EDIT_TOOL, '{"path":"a.txt","note":null}');
    expect(results.map(({ kind, events }) => ({ kind, arguments: doneItemArguments(events) }))).toEqual(
      results.map(({ kind }) => ({ kind, arguments: ['{"path":"a.txt"}'] })),
    );
  });

  it('emits no argument delta carrying the recorded null on any reader', async () => {
    const results = await throughEveryReader(EDIT_TOOL, '{"path":"a.txt","note":null}');
    expect(results.map(({ kind, events }) => ({ kind, nulls: argumentDeltas(events).join('').includes('null') }))).toEqual(
      results.map(({ kind }) => ({ kind, nulls: false })),
    );
  });

  it('keeps null for a property whose original schema admits null, on every reader', async () => {
    const results = await throughEveryReader(LOOK_TOOL, '{"q":null}');
    expect(results.map(({ kind, events }) => ({ kind, arguments: doneItemArguments(events) }))).toEqual(
      results.map(({ kind }) => ({ kind, arguments: ['{"q":null}'] })),
    );
  });
});
