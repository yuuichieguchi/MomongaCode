import { keyAuthSource, unauthenticatedSource } from '@momonga/gateway';
import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/gateway';
import type { AdapterRequest, AdapterTarget, Capabilities, StreamEvent } from '@momonga/protocol';
import { anthropicTextReply, createFakeClock, openResponsesTextReply, startFakeAnthropic, startFakeOpenResponses } from '@momonga/testkit';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { CC_CAPABILITIES, collect, makeAdapter, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';
import { startJsonObjectAcceptingProxy } from './json-object-proxy.ts';
import { OLLAMA_CAPABILITIES, chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { contextOf } from './own-reasoning.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const JSON_TEXT = '{"verdict":"safe"}';

const askingForJsonObject = (): AdapterRequest => ({
  model: 'm',
  instructions: 'Reply with one JSON object.',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  text: { format: { type: 'json_object' } },
});

type JsonMode = 'json_object' | 'none' | undefined;

const withModes = (base: Capabilities, structuredOutput: Capabilities['structuredOutput'], jsonMode: JsonMode): Capabilities => {
  const { jsonMode: _dropped, ...rest } = { ...base, structuredOutput } as Capabilities & { jsonMode?: unknown };
  return (jsonMode === undefined ? rest : { ...rest, jsonMode }) as Capabilities;
};

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

type Sent = { wire: any; events: StreamEvent[]; error: unknown };

type Surface = {
  name: string;
  base: Capabilities;
  send(capabilities: Capabilities, request: AdapterRequest, replyText: string): Promise<Sent>;
  formatOf(wire: any): unknown;
};

type NativeSurface = Surface & { nativeForm: unknown };

const chatCompletions: NativeSurface = {
  name: 'chat-completions',
  base: CC_CAPABILITIES,
  send: async (capabilities, request, replyText) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(replyText)] });
    const proxy = await startJsonObjectAcceptingProxy(fake.socketPath);
    const adapter = makeAdapter(fake, { capabilities: async () => capabilities, resolveEndpoint: async () => ({ kind: 'unix', socketPath: proxy.socketPath }) });
    const { events, error } = await collect(adapter, request);
    return { wire: proxy.bodies().at(-1), events, error };
  },
  formatOf: (wire) => wire?.response_format,
  nativeForm: { type: 'json_object' },
};

const ollama: NativeSurface = {
  name: 'ollama',
  base: OLLAMA_CAPABILITIES,
  send: async (capabilities, request, replyText) => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines: [chunkLine({ content: replyText }), doneLine()] }] });
    const adapter = makeOllamaAdapter(fake, { capabilities: async () => capabilities });
    const { events, error } = await collectOllama(adapter, request);
    return { wire: fake.chatBodies().at(-1), events, error };
  },
  formatOf: (wire) => wire?.format,
  nativeForm: 'json',
};

const openResponses: NativeSurface = {
  name: 'open-responses',
  base: REMOTE_CAPABILITIES,
  send: async (capabilities, request, replyText) => {
    const fake = await startFakeOpenResponses({ script: [openResponsesTextReply([replyText])] });
    registerCleanup(() => fake.close());
    const adapter = createOpenResponsesAdapter({ authSource: unauthenticatedSource, liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      capabilities: async () => capabilities,
      clock: createFakeClock(START_MS),
    });
    registerCleanup(() => adapter.close());
    const { events, error } = await drain(adapter, { name: 'remote', display: 'remote', model: 'gpt-fake' }, request);
    return { wire: fake.requests.at(-1)?.body as any, events, error };
  },
  formatOf: (wire) => wire?.text?.format,
  nativeForm: { type: 'json_object' },
};

const anthropic: Surface = {
  name: 'anthropic',
  base: REMOTE_CAPABILITIES,
  send: async (capabilities, request, replyText) => {
    const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: [anthropicTextReply([replyText])] });
    registerCleanup(() => fake.close());
    const adapter = createAnthropicAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      authSource: keyAuthSource(async () => FAKE_API_KEY),
      capabilities: async () => capabilities,
      clock: createFakeClock(START_MS),
      apiVersion: '2026-10-21',
    });
    registerCleanup(() => adapter.close());
    const { events, error } = await drain(adapter, { name: 'remote', display: 'remote', model: 'claude-fake' }, request);
    return { wire: fake.requests.at(-1)?.body as any, events, error };
  },
  formatOf: (wire) => wire?.output_config?.format,
};

describe.each([chatCompletions, ollama, openResponses])('JSON-only mode on the wire: $name', (surface) => {
  it('sends the native JSON-only form and reports enforced when the target has the mode', async () => {
    const sent = await surface.send(withModes(surface.base, 'none', 'json_object'), askingForJsonObject(), JSON_TEXT);
    expect(sent.error).toBeUndefined();
    expect(surface.formatOf(sent.wire)).toEqual(surface.nativeForm);
    expect(terminalOf(sent.events)['jsonReply']).toBe('enforced');
  });

  it.each([['declared none', 'none'], ['unmeasured', undefined]] as const)('sends no format and reports prompt when the mode is %s', async (_label, jsonMode) => {
    const sent = await surface.send(withModes(surface.base, 'none', jsonMode), askingForJsonObject(), JSON_TEXT);
    expect(sent.error).toBeUndefined();
    expect(surface.formatOf(sent.wire)).toBeUndefined();
    expect(terminalOf(sent.events)['jsonReply']).toBe('prompt');
  });

  it('never infers the mode from structuredOutput: json_schema without the mode is the prompt path', async () => {
    const sent = await surface.send(withModes(surface.base, 'json_schema', undefined), askingForJsonObject(), JSON_TEXT);
    expect(sent.error).toBeUndefined();
    expect(surface.formatOf(sent.wire)).toBeUndefined();
    expect(terminalOf(sent.events)['jsonReply']).toBe('prompt');
  });

  it('sends the caller instructions unchanged on both paths', async () => {
    const enforced = await surface.send(withModes(surface.base, 'none', 'json_object'), askingForJsonObject(), JSON_TEXT);
    const prompt = await surface.send(withModes(surface.base, 'none', 'none'), askingForJsonObject(), JSON_TEXT);
    expect(JSON.stringify(enforced.wire ?? null)).toContain('Reply with one JSON object.');
    expect(JSON.stringify(prompt.wire ?? null)).toContain('Reply with one JSON object.');
  });
});

describe('JSON-only mode on the anthropic wire, which has no native JSON-only form', () => {
  it('sends no format and reports prompt for a target without the mode', async () => {
    const sent = await anthropic.send(withModes(anthropic.base, 'json_schema', undefined), askingForJsonObject(), JSON_TEXT);
    expect(sent.error).toBeUndefined();
    expect(anthropic.formatOf(sent.wire)).toBeUndefined();
    expect(terminalOf(sent.events)['jsonReply']).toBe('prompt');
  });

});
