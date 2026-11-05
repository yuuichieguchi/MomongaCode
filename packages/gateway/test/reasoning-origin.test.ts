import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { AdapterInputItem, AdapterRequest, AdapterTarget, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import {
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicStream,
  anthropicTextBlock,
  anthropicTextReply,
  createFakeClock,
  openResponsesStream,
  openResponsesTextReply,
  openingEvents,
  startFakeAnthropic,
  startFakeOpenResponses,
  terminalEvent,
} from '@momonga/testkit';
import type { FakeStreamChunk, FakeUpstreamReply } from '@momonga/testkit';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { completionBodies, makeAdapter, startFake } from './cc-support.ts';
import { QWEN_NATIVE_THINKING, QWEN_MODEL, chunkLine, doneLine, fixtureLines, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

type Origin = { adapter: 'chat-completions' | 'anthropic' | 'ollama' | 'open-responses'; model: string };

const CC_MODEL = 'cc-model-x';
const ANTHROPIC_MODEL = 'claude-model-x';
const RELAY_MODEL = 'relay-model-x';

const OLLAMA_TEXT = 'ollama-origin thought';
const ANTHROPIC_TEXT = 'anthropic-origin thought';
const CC_TEXT = 'chat-completions-origin thought';
const RELAY_TEXT = 'open-responses-origin thought';
const ANTHROPIC_SIGNATURE = 'anthropic-origin-signature';
const RELAY_ENCRYPTED = 'open-responses-origin-encrypted';

const reasoning = (id: string, text: string, origin: Origin, extra: Record<string, unknown> = {}): AdapterInputItem =>
  ({ type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text }], ...extra, origin }) as unknown as AdapterInputItem;

const ollamaOrigin = reasoning('rs_ollama', OLLAMA_TEXT, { adapter: 'ollama', model: QWEN_MODEL });
const anthropicOrigin = reasoning('rs_anthropic', ANTHROPIC_TEXT, { adapter: 'anthropic', model: ANTHROPIC_MODEL }, { signature: ANTHROPIC_SIGNATURE });
const ccOrigin = reasoning('rs_cc', CC_TEXT, { adapter: 'chat-completions', model: CC_MODEL }, { reasoning_field: 'reasoning_content' });
const relayOrigin = reasoning('rs_relay', RELAY_TEXT, { adapter: 'open-responses', model: RELAY_MODEL }, { encrypted_content: RELAY_ENCRYPTED });

const user = (text: string): AdapterInputItem => ({ type: 'message', role: 'user', content: text });
const assistant = (text: string): AdapterInputItem => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }) as AdapterInputItem;

const mixedHistory = (): AdapterInputItem[] => [
  user('first'),
  ollamaOrigin,
  assistant('one'),
  user('second'),
  anthropicOrigin,
  assistant('two'),
  user('third'),
  ccOrigin,
  assistant('three'),
  user('fourth'),
  relayOrigin,
  assistant('four'),
  user('again'),
];

const ALL_TEXTS = [OLLAMA_TEXT, ANTHROPIC_TEXT, CC_TEXT, RELAY_TEXT];

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const expectOnlyOwn = (wire: unknown, own: string): void => {
  const text = JSON.stringify(wire);
  expect(ALL_TEXTS.map((candidate) => [candidate, occurrences(text, candidate)])).toEqual(
    ALL_TEXTS.map((candidate) => [candidate, candidate === own ? 1 : 0]),
  );
};

const drain = async (adapter: ProviderAdapter, request: AdapterRequest, target: AdapterTarget): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of adapter.create(request, { signal: new AbortController().signal, target, attempt: 1 })) events.push(event);
  return events;
};

const terminalOutput = (events: readonly StreamEvent[]): any[] => {
  const last: any = events.at(-1);
  expect(last.type).toBe('response.completed');
  return last.response.output;
};

const targetOf = (prefix: string, model: string): AdapterTarget => ({ name: `${prefix}-${model}`, model });

const ccTextReply = { kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'ok' } }, { delta: {}, finishReason: 'stop' }] };

const startCc = async (script: unknown[]) => {
  const fake = await startFake({ scenario: 'none', script } as never);
  return { fake, adapter: makeAdapter(fake) };
};

const startOllama = async (replies: Array<{ kind: 'ndjson'; lines: readonly string[] }>) => {
  const fake = await startFakeOllama({ chat: replies });
  return { fake, adapter: makeOllamaAdapter(fake) };
};

const ollamaTextReply = { kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] };

const startAnthropic = async (script: FakeUpstreamReply[]) => {
  const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script });
  registerCleanup(() => fake.close());
  const adapter = createAnthropicAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    apiKey: async () => FAKE_API_KEY,
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return { fake, adapter };
};

const anthropicBodies = (fake: { requests: Array<{ path: string; body: unknown }> }): any[] =>
  fake.requests.filter((request) => request.path === '/v1/messages').map((request) => request.body);

const startRelay = async (script: FakeUpstreamReply[]) => {
  const fake = await startFakeOpenResponses({ script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  return { fake, adapter };
};

const relayBodies = (fake: { requests: Array<{ body: unknown }> }): any[] => fake.requests.map((request) => request.body);

describe('a renderer sends only the reasoning its own target produced (item 5, rule A)', () => {
  it('chat-completions sends its own item and none of the ollama, anthropic or relay ones', async () => {
    const { fake, adapter } = await startCc([ccTextReply]);
    await drain(adapter, { model: CC_MODEL, input: mixedHistory() }, targetOf('cc', CC_MODEL));
    expectOnlyOwn(completionBodies(fake).at(-1).messages, CC_TEXT);
  });

  it('ollama sends its own item as thinking and none of the anthropic, chat-completions or relay ones', async () => {
    const { fake, adapter } = await startOllama([ollamaTextReply]);
    await drain(adapter, { model: QWEN_MODEL, input: mixedHistory() }, targetOf('ollama', QWEN_MODEL));
    const messages: any[] = fake.chatBodies().at(-1).messages;
    expectOnlyOwn(messages, OLLAMA_TEXT);
    expect(messages.filter((message) => message.thinking !== undefined).map((message) => message.thinking)).toEqual([OLLAMA_TEXT]);
  });

  it('anthropic sends its own signed block and none of the ollama, chat-completions or relay ones', async () => {
    const { fake, adapter } = await startAnthropic([anthropicTextReply(['ok'])]);
    await drain(adapter, { model: ANTHROPIC_MODEL, input: mixedHistory() }, targetOf('anthropic', ANTHROPIC_MODEL));
    const messages: any[] = anthropicBodies(fake).at(-1).messages;
    expectOnlyOwn(messages, ANTHROPIC_TEXT);
    expect(messages.flatMap((message) => message.content).filter((block: any) => block.type === 'thinking')).toEqual([
      { type: 'thinking', thinking: ANTHROPIC_TEXT, signature: ANTHROPIC_SIGNATURE },
    ]);
  });

  it('the relay sends its own reasoning item and none of the ollama, anthropic or chat-completions ones', async () => {
    const { fake, adapter } = await startRelay([openResponsesTextReply(['ok'])]);
    await drain(adapter, { model: RELAY_MODEL, input: mixedHistory() }, targetOf('relay', RELAY_MODEL));
    const input: any[] = relayBodies(fake).at(-1).input;
    expectOnlyOwn(input, RELAY_TEXT);
    expect(input.filter((item) => item.type === 'reasoning').map((item) => item.encrypted_content)).toEqual([RELAY_ENCRYPTED]);
  });
});

describe('two targets of the same adapter with different model ids (item 5, the marker is needed)', () => {
  const X_TEXT = 'thought of model x';
  const Y_TEXT = 'thought of model y';
  const sameAdapterHistory = (adapter: Origin['adapter'], extraOf: (tag: string) => Record<string, unknown>): AdapterInputItem[] => [
    user('first'),
    reasoning('rs_x', X_TEXT, { adapter, model: 'model-x' }, extraOf('x')),
    assistant('one'),
    user('second'),
    reasoning('rs_y', Y_TEXT, { adapter, model: 'model-y' }, extraOf('y')),
    assistant('two'),
    user('again'),
  ];
  const expectOnlyY = (wire: unknown): void => {
    const text = JSON.stringify(wire);
    expect([occurrences(text, X_TEXT), occurrences(text, Y_TEXT)]).toEqual([0, 1]);
  };

  it('chat-completions on model y leaves out the item of model x, though both carry reasoning_field', async () => {
    const { fake, adapter } = await startCc([ccTextReply]);
    await drain(adapter, { model: 'model-y', input: sameAdapterHistory('chat-completions', () => ({ reasoning_field: 'reasoning_content' })) }, targetOf('cc', 'model-y'));
    expectOnlyY(completionBodies(fake).at(-1).messages);
  });

  it('ollama on model y leaves out the item of model x, though both carry readable text', async () => {
    const { fake, adapter } = await startOllama([ollamaTextReply]);
    await drain(adapter, { model: 'model-y', input: sameAdapterHistory('ollama', () => ({})) }, targetOf('ollama', 'model-y'));
    expectOnlyY(fake.chatBodies().at(-1).messages);
  });

  it('anthropic on model y leaves out the item of model x, though both carry a signature', async () => {
    const { fake, adapter } = await startAnthropic([anthropicTextReply(['ok'])]);
    await drain(adapter, { model: 'model-y', input: sameAdapterHistory('anthropic', (tag) => ({ signature: `signature-${tag}` })) }, targetOf('anthropic', 'model-y'));
    const messages: any[] = anthropicBodies(fake).at(-1).messages;
    expectOnlyY(messages);
    expect(JSON.stringify(messages).includes('signature-x')).toBe(false);
  });

  it('the relay on model y leaves out the item of model x, though both carry encrypted_content', async () => {
    const { fake, adapter } = await startRelay([openResponsesTextReply(['ok'])]);
    await drain(adapter, { model: 'model-y', input: sameAdapterHistory('open-responses', (tag) => ({ encrypted_content: `encrypted-${tag}` })) }, targetOf('relay', 'model-y'));
    const input: any[] = relayBodies(fake).at(-1).input;
    expectOnlyY(input);
    expect(input.filter((item) => item.type === 'reasoning').map((item) => item.encrypted_content)).toEqual(['encrypted-y']);
  });
});

describe('each adapter records the origin marker on the reasoning item it produces (item 5)', () => {
  it('chat-completions marks the item with its wire form and the target model', async () => {
    const chunks: FakeStreamChunk[] = [
      { delta: { role: 'assistant', content: '' } },
      { delta: { reasoning_content: 'thinking aloud' } },
      { delta: { content: 'ok' } },
      { delta: {}, finishReason: 'stop' },
    ];
    const { adapter } = await startCc([{ kind: 'stream', chunks }]);
    const output = terminalOutput(await drain(adapter, { model: CC_MODEL, input: [user('hi')] }, targetOf('cc', CC_MODEL)));
    expect(output.filter((item) => item.type === 'reasoning').map((item) => item.origin)).toEqual([{ adapter: 'chat-completions', model: CC_MODEL }]);
  });

  it('ollama marks the item with its wire form and the target model', async () => {
    const { adapter } = await startOllama([{ kind: 'ndjson', lines: fixtureLines(QWEN_NATIVE_THINKING) }]);
    const output = terminalOutput(await drain(adapter, { model: QWEN_MODEL, input: [user('read a.txt')] }, targetOf('ollama', QWEN_MODEL)));
    expect(output.filter((item) => item.type === 'reasoning').map((item) => item.origin)).toEqual([{ adapter: 'ollama', model: QWEN_MODEL }]);
  });

  it('anthropic marks the item with its wire form and the target model', async () => {
    const stream = anthropicStream([
      anthropicMessageStart(),
      anthropicBlockStart(0, { type: 'thinking', thinking: '' }),
      anthropicBlockDelta(0, { type: 'thinking_delta', thinking: 'thinking aloud' }),
      anthropicBlockDelta(0, { type: 'signature_delta', signature: ANTHROPIC_SIGNATURE }),
      anthropicBlockStop(0),
      ...anthropicTextBlock(1, ['ok']),
      ...anthropicMessageEnd('end_turn'),
    ]);
    const { adapter } = await startAnthropic([stream]);
    const output = terminalOutput(await drain(adapter, { model: ANTHROPIC_MODEL, input: [user('hi')] }, targetOf('anthropic', ANTHROPIC_MODEL)));
    expect(output.filter((item) => item.type === 'reasoning').map((item) => item.origin)).toEqual([{ adapter: 'anthropic', model: ANTHROPIC_MODEL }]);
  });

  it('the relay marks the item with its wire form and the target model', async () => {
    const item = { type: 'reasoning', id: 'rs_up_1', summary: [], content: [{ type: 'reasoning_text', text: 'thinking aloud' }], encrypted_content: RELAY_ENCRYPTED };
    const stream = openResponsesStream([
      ...openingEvents(),
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_up_1', summary: [], content: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      terminalEvent({ kind: 'completed' }, [item]),
    ] as never);
    const { adapter } = await startRelay([stream]);
    const output = terminalOutput(await drain(adapter, { model: RELAY_MODEL, input: [user('hi')] }, targetOf('relay', RELAY_MODEL)));
    expect(output.filter((entry) => entry.type === 'reasoning').map((entry) => entry.origin)).toEqual([{ adapter: 'open-responses', model: RELAY_MODEL }]);
  });
});
