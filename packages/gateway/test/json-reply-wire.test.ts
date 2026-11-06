import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/gateway';
import type { AdapterRequest, AdapterTarget, Capabilities, StreamEvent } from '@momonga/protocol';
import { anthropicTextReply, createFakeClock, openResponsesTextReply, startFakeAnthropic, startFakeOpenResponses } from '@momonga/testkit';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { CC_CAPABILITIES, collect, completionBodies, makeAdapter, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';
import { OLLAMA_CAPABILITIES, chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { contextOf } from './own-reasoning.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES, readFileTool } from './upstream-gateway-support.ts';

const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['safe', 'unsafe'] } },
  required: ['verdict'],
  additionalProperties: false,
} as const;

const askingForJson = (extra: Partial<AdapterRequest> = {}): AdapterRequest => ({
  model: 'm',
  instructions: 'Reply with one JSON value.',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  text: { format: { type: 'json_schema', name: 'reply', strict: true, schema: { ...SCHEMA } } },
  ...extra,
});

const plain = (): AdapterRequest => ({ model: 'm', input: [{ type: 'message', role: 'user', content: 'hello' }] });

const terminalOf = (events: readonly StreamEvent[]): Record<string, unknown> => {
  const terminal = events.find((event) => event.type === 'response.completed' || event.type === 'response.incomplete');
  if (terminal === undefined || !('response' in terminal)) throw new Error('no terminal event');
  return terminal.response as unknown as Record<string, unknown>;
};

const drain = async (adapter: ProviderAdapter, target: AdapterTarget, request: AdapterRequest): Promise<{ events: StreamEvent[]; error: unknown }> => {
  const events: StreamEvent[] = [];
  try {
    for await (const event of adapter.create(request, await contextOf(adapter, target))) events.push(event);
  } catch (error) {
    return { events, error };
  }
  return { events, error: undefined };
};

type Sent = { wire: any; events: StreamEvent[]; instructionsOnWire: string | undefined; error: unknown };

const withOutput = (base: Capabilities, structuredOutput: Capabilities['structuredOutput']): Capabilities => ({ ...base, structuredOutput });

type Surface = {
  name: string;
  base: Capabilities;
  send(capabilities: Capabilities, request: AdapterRequest): Promise<Sent>;
  formatOf(wire: any): unknown;
  enforcedForm: unknown;
};

const chatCompletions: Surface = {
  name: 'chat-completions',
  base: CC_CAPABILITIES,
  send: async (capabilities, request) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('{"verdict":"safe"}')] });
    const adapter = makeAdapter(fake, { capabilities: async () => capabilities });
    const { events, error } = await collect(adapter, request);
    const wire = completionBodies(fake).at(-1);
    return { wire, events, error, instructionsOnWire: wire?.messages[0].content };
  },
  formatOf: (wire) => wire.response_format,
  enforcedForm: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: SCHEMA } },
};

const anthropic: Surface = {
  name: 'anthropic',
  base: REMOTE_CAPABILITIES,
  send: async (capabilities, request) => {
    const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: [anthropicTextReply(['{"verdict":"safe"}'])] });
    registerCleanup(() => fake.close());
    const adapter = createAnthropicAdapter({
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      apiKey: async () => FAKE_API_KEY,
      capabilities: async () => capabilities,
      clock: createFakeClock(START_MS),
      apiVersion: '2026-10-21',
    });
    registerCleanup(() => adapter.close());
    const { events, error } = await drain(adapter, { name: 'remote', model: 'claude-fake' }, request);
    const wire = fake.requests.at(-1)?.body as any;
    return { wire, events, error, instructionsOnWire: wire?.system?.[0]?.text };
  },
  formatOf: (wire) => wire.output_config?.format,
  enforcedForm: { type: 'json_schema', schema: SCHEMA },
};

const openResponses: Surface = {
  name: 'open-responses',
  base: REMOTE_CAPABILITIES,
  send: async (capabilities, request) => {
    const fake = await startFakeOpenResponses({ script: [openResponsesTextReply(['{"verdict":"safe"}'])] });
    registerCleanup(() => fake.close());
    const adapter = createOpenResponsesAdapter({
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      capabilities: async () => capabilities,
      clock: createFakeClock(START_MS),
    });
    registerCleanup(() => adapter.close());
    const { events, error } = await drain(adapter, { name: 'remote', model: 'gpt-fake' }, request);
    const wire = fake.requests.at(-1)?.body as any;
    return { wire, events, error, instructionsOnWire: wire?.instructions };
  },
  formatOf: (wire) => wire.text?.format,
  enforcedForm: { type: 'json_schema', name: 'reply', strict: true, schema: SCHEMA },
};

const ollama: Surface = {
  name: 'ollama',
  base: OLLAMA_CAPABILITIES,
  send: async (capabilities, request) => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines: [chunkLine({ content: '{"verdict":"safe"}' }), doneLine()] }] });
    const adapter = makeOllamaAdapter(fake, { capabilities: async () => capabilities });
    const { events, error } = await collectOllama(adapter, request);
    const wire = fake.chatBodies().at(-1);
    return { wire, events, error, instructionsOnWire: wire?.messages[0].content };
  },
  formatOf: (wire) => wire.format,
  enforcedForm: SCHEMA,
};

describe.each([chatCompletions, anthropic, openResponses, ollama])('JSON reply on the wire: $name', (surface) => {
  it('puts the rendered format on the wire and reports enforced when the target measured json_schema', async () => {
    const sent = await surface.send(withOutput(surface.base, 'json_schema'), askingForJson());
    expect(sent.error).toBeUndefined();
    expect(surface.formatOf(sent.wire)).toEqual(surface.enforcedForm);
    expect(terminalOf(sent.events)['jsonReply']).toBe('enforced');
  });

  it('omits the format and reports prompt when the target did not measure json_schema', async () => {
    const sent = await surface.send(withOutput(surface.base, 'none'), askingForJson());
    expect(sent.error).toBeUndefined();
    expect(surface.formatOf(sent.wire)).toBeUndefined();
    expect(terminalOf(sent.events)['jsonReply']).toBe('prompt');
  });

  it('sends the same instructions on both paths', async () => {
    const enforced = await surface.send(withOutput(surface.base, 'json_schema'), askingForJson());
    const prompt = await surface.send(withOutput(surface.base, 'none'), askingForJson());
    expect(enforced.instructionsOnWire).toBe(prompt.instructionsOnWire);
    expect(prompt.instructionsOnWire).toContain('Reply with one JSON value.');
  });

  it('decides from structuredOutput alone: capabilities that differ elsewhere give the same answer', async () => {
    const other: Capabilities = { ...withOutput(surface.base, 'json_schema'), source: 'declared', tokenCounting: 'exact', maxConcurrency: 7 };
    const sent = await surface.send(other, askingForJson());
    expect(terminalOf(sent.events)['jsonReply']).toBe('enforced');
  });

  it('accepts a json_object format on either path instead of refusing it', async () => {
    for (const structuredOutput of ['json_schema', 'none'] as const) {
      const request: AdapterRequest = { ...plain(), text: { format: { type: 'json_object' } } };
      const sent = await surface.send(withOutput(surface.base, structuredOutput), request);
      expect(sent.error).toBeUndefined();
      expect(sent.wire).toBeDefined();
      expect(terminalOf(sent.events)['jsonReply']).toBe('prompt');
    }
  });

  it('reports nothing for a request that asks for no format', async () => {
    const sent = await surface.send(withOutput(surface.base, 'none'), plain());
    expect(surface.formatOf(sent.wire)).toBeUndefined();
    expect(terminalOf(sent.events)).not.toHaveProperty('jsonReply');
  });
});

describe('JSON reply together with tools on chat-completions', () => {
  it('refuses the combination on the constrained envelope instead of choosing one, sending nothing', async () => {
    const fake = await startFake({ scenario: 'json-schema-only', script: [textReply('{"kind":"final","text":"ok"}')] });
    const adapter = makeAdapter(fake, { capabilities: async () => ({ ...withOutput(CC_CAPABILITIES, 'json_schema'), toolCalling: 'constrained' }) }, 'constrained');
    const { error } = await collect(adapter, askingForJson({ tools: [readFileTool] }));
    expect(error).toMatchObject({ code: 'unsupported_input' });
    expect(completionBodies(fake)).toEqual([]);
  });
});
