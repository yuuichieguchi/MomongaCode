import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAnthropicAdapter, createOpenResponsesAdapter } from '@momonga/gateway';
import type { ProviderAdapter } from '@momonga/protocol';
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
import type { FakeUpstreamReply } from '@momonga/testkit';
import { HMAC_KEY, START_MS, postJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { completionBodies, makeAdapter, startFake } from './cc-support.ts';
import { chunkLine, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

export type AdapterKind = 'chat-completions' | 'anthropic' | 'ollama' | 'open-responses';
export const ADAPTER_KINDS: readonly AdapterKind[] = ['chat-completions', 'anthropic', 'ollama', 'open-responses'];

export const OTHER_GATEWAY_KEY = Buffer.from('momonga-test-hmac-key-other-gateway-padded', 'utf8');

export type Thought = { text: string; opaque: string };

export const thoughtOf = (kind: AdapterKind, model: string): Thought => ({
  text: `${kind} thought of ${model}`,
  opaque: `${kind}-opaque-of-${model}`,
});

type Script = { reasoning: Thought } | { text: string };

const ccReply = (step: Script) =>
  'reasoning' in step
    ? {
        kind: 'stream',
        chunks: [
          { delta: { role: 'assistant', content: '' } },
          { delta: { reasoning_content: step.reasoning.text } },
          { delta: { content: 'answer' } },
          { delta: {}, finishReason: 'stop' },
        ],
      }
    : { kind: 'stream', chunks: [{ delta: { role: 'assistant', content: step.text } }, { delta: {}, finishReason: 'stop' }] };

const ollamaReply = (step: Script) => ({
  kind: 'ndjson' as const,
  lines: 'reasoning' in step ? [chunkLine({ thinking: step.reasoning.text }), chunkLine({ content: 'answer' }), doneLine()] : [chunkLine({ content: step.text }), doneLine()],
});

const anthropicReply = (step: Script): FakeUpstreamReply =>
  'reasoning' in step
    ? anthropicStream([
        anthropicMessageStart(),
        anthropicBlockStart(0, { type: 'thinking', thinking: '' }),
        anthropicBlockDelta(0, { type: 'thinking_delta', thinking: step.reasoning.text }),
        anthropicBlockDelta(0, { type: 'signature_delta', signature: step.reasoning.opaque }),
        anthropicBlockStop(0),
        ...anthropicTextBlock(1, ['answer']),
        ...anthropicMessageEnd('end_turn'),
      ])
    : anthropicTextReply([step.text]);

let relayIds = 0;

const relayReply = (step: Script): FakeUpstreamReply => {
  if (!('reasoning' in step)) return openResponsesTextReply([step.text]);
  relayIds += 1;
  const id = `rs_up_${relayIds}`;
  const item = { type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text: step.reasoning.text }], encrypted_content: step.reasoning.opaque };
  const message = { type: 'message', id: `msg_up_${relayIds}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] };
  return openResponsesStream([
    ...openingEvents(),
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id, summary: [], content: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_item.added', output_index: 1, item: message },
    { type: 'response.output_item.done', output_index: 1, item: message },
    terminalEvent({ kind: 'completed' }, [item, message]),
  ] as never);
};

export type Upstream = { adapter: ProviderAdapter; wire: () => string; bodies: () => any[] };

const startUpstream = async (kind: AdapterKind, script: readonly Script[]): Promise<Upstream> => {
  if (kind === 'chat-completions') {
    const fake = await startFake({ scenario: 'none', script: script.map(ccReply) } as never);
    const bodies = () => completionBodies(fake).map((body) => body.messages);
    return { adapter: makeAdapter(fake), bodies, wire: () => JSON.stringify(bodies().at(-1)) };
  }
  if (kind === 'ollama') {
    const fake = await startFakeOllama({ chat: script.map(ollamaReply) });
    const bodies = () => fake.chatBodies().map((body: any) => body.messages);
    return { adapter: makeOllamaAdapter(fake), bodies, wire: () => JSON.stringify(bodies().at(-1)) };
  }
  if (kind === 'anthropic') {
    const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: script.map(anthropicReply) });
    registerCleanup(() => fake.close());
    const adapter = createAnthropicAdapter({
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      apiKey: async () => FAKE_API_KEY,
      capabilities: async () => REMOTE_CAPABILITIES,
      clock: createFakeClock(START_MS),
      apiVersion: '2026-10-21',
    });
    registerCleanup(() => adapter.close());
    const bodies = () => fake.requests.filter((request) => request.path === '/v1/messages').map((request: any) => request.body.messages);
    return { adapter, bodies, wire: () => JSON.stringify(bodies().at(-1)) };
  }
  const fake = await startFakeOpenResponses({ script: script.map(relayReply) });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  const bodies = () => fake.requests.map((request: any) => request.body.input);
  return { adapter, bodies, wire: () => JSON.stringify(bodies().at(-1)) };
};

export type TargetPlan = { name: string; kind: AdapterKind; model: string; script: readonly Script[] };

export type World = {
  client: Awaited<ReturnType<typeof startGateway>>['client'];
  upstreams: Record<string, Upstream>;
  turn: (target: string, input: unknown[]) => Promise<any[]>;
};

export const startWorld = async (plans: readonly TargetPlan[], hmacKey: Uint8Array = HMAC_KEY): Promise<World> => {
  const upstreams: Record<string, Upstream> = {};
  for (const plan of plans) upstreams[plan.name] = await startUpstream(plan.kind, plan.script);
  const { client } = await startGateway({
    hmacKey,
    adapters: Object.fromEntries(plans.map((plan) => [plan.name, upstreams[plan.name]!.adapter])),
    config: {
      aliases: Object.fromEntries(plans.map((plan) => [`via-${plan.name}`, [plan.name]])),
      targets: Object.fromEntries(plans.map((plan) => [plan.name, { model: plan.model, kind: 'remote' as const }])),
      retry: { maxAttempts: 1 },
    },
  });
  const turn = async (target: string, input: unknown[]): Promise<any[]> => {
    const frames = await readSse(await postJson(client, '/v1/responses', { model: `via-${target}`, stream: true, input }));
    const last = frames.at(-1)?.data;
    if (last?.type !== 'response.completed') throw new Error(`turn on ${target} did not complete: ${JSON.stringify(last)}`);
    return last.response.output;
  };
  return { client, upstreams, turn };
};

export const reasoningOf = (output: readonly any[]): any => {
  const items = output.filter((item) => item.type === 'reasoning');
  if (items.length !== 1) throw new Error(`expected one reasoning item, got ${JSON.stringify(output)}`);
  return items[0];
};

export const strictReasoning = (item: any): Record<string, unknown> => {
  const kept: Record<string, unknown> = {};
  for (const field of ['id', 'type', 'summary', 'content', 'encrypted_content']) if (item[field] !== undefined) kept[field] = item[field];
  return kept;
};

export const strictHistory = (output: readonly any[]): any[] => output.map((item) => (item.type === 'reasoning' ? strictReasoning(item) : item));

export const verifiedEnvelope = (encrypted: unknown, key: Uint8Array = HMAC_KEY): Record<string, unknown> | undefined => {
  if (typeof encrypted !== 'string') return undefined;
  const parts = encrypted.split('.');
  if (parts.length !== 2) return undefined;
  const [payloadSegment, macSegment] = parts as [string, string];
  const presented = Buffer.from(macSegment, 'base64url');
  const expected = createHmac('sha256', key).update(payloadSegment).digest();
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
  return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
};

export const tampered = (encrypted: string): string => {
  const dot = encrypted.indexOf('.');
  const at = dot > 0 ? dot - 2 : encrypted.length - 2;
  const swapped = encrypted[at] === 'A' ? 'B' : 'A';
  return `${encrypted.slice(0, at)}${swapped}${encrypted.slice(at + 1)}`;
};

export const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

export const ask = (text: string) => userInput(text);
