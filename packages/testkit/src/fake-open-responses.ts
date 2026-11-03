import { canonicalJson } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
import type { Usage } from '@momonga/protocol';
import type { FakeSseFrame, FakeUpstreamOptions, FakeUpstreamReply, FakeUpstreamServer } from './fake-sse-upstream.ts';
import { startFakeSseUpstream } from './fake-sse-upstream.ts';
import { responseResource, usageOf } from './open-responses-fixtures.ts';
import type { ResponseResourceInput } from './open-responses-fixtures.ts';

export const FAKE_OPEN_RESPONSES_PATH = '/v1/responses';

export type FakeOpenResponsesOptions = {
  apiKey?: string;
  script?: FakeUpstreamReply[];
  respond?: Parameters<typeof startFakeSseUpstream>[0]['respond'];
  socketPath?: string;
};

const USAGE_BEARING_TERMINALS = ['response.completed', 'response.incomplete'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const withInputTokens = (reply: FakeUpstreamReply, inputTokens: number): FakeUpstreamReply => {
  if (reply.kind !== 'stream') return reply;
  return {
    ...reply,
    frames: reply.frames.map((frame) => {
      const data = frame.data;
      if (!isRecord(data) || !USAGE_BEARING_TERMINALS.includes(String(data['type'])) || !isRecord(data['response'])) return frame;
      if (data['response']['usage'] !== undefined) return frame;
      const outputTokens = tokensForText(canonicalJson(data['response']['output']));
      return { ...frame, data: { ...data, response: { ...data['response'], usage: usageOf(inputTokens, outputTokens) } } };
    }),
  };
};

export const openResponsesErrorBody = (type: string, code: string | null, message: string): { error: { type: string; code: string | null; message: string; param: null } } => ({
  error: { type, code, message, param: null },
});

export const openResponsesErrorReply = (
  status: number,
  type: string,
  code: string | null,
  message: string,
  headers?: Record<string, string>,
): FakeUpstreamReply => ({
  kind: 'error',
  status,
  body: openResponsesErrorBody(type, code, message),
  ...(headers === undefined ? {} : { headers }),
});

const responderOf = (options: FakeOpenResponsesOptions): NonNullable<FakeUpstreamOptions['respond']> => {
  if (options.script !== undefined && options.respond !== undefined) throw new Error('startFakeOpenResponses takes a script or respond, not both');
  const script = [...(options.script ?? [])];
  const inner = options.respond ?? (() => script.shift());
  return (request) => {
    const reply = inner(request);
    if (reply === undefined) return reply;
    return withInputTokens(reply, tokensForText(JSON.stringify(request.body)));
  };
};

export const startFakeOpenResponses = (options: FakeOpenResponsesOptions): Promise<FakeUpstreamServer> => {
  const respond = responderOf(options);
  return startFakeSseUpstream({
    path: FAKE_OPEN_RESPONSES_PATH,
    respond,
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(options.apiKey === undefined
      ? {}
      : {
          authenticate: (headers: Record<string, unknown>): FakeUpstreamReply | undefined =>
            headers['authorization'] === `Bearer ${options.apiKey}`
              ? undefined
              : openResponsesErrorReply(401, 'invalid_request', 'invalid_api_key', 'the bearer token is not valid'),
        }),
  });
};

const MODEL = 'open-responses-fake';
const RESPONSE_ID = 'resp_fake_1';
const MESSAGE_ID = 'msg_fake_1';
const CALL_ITEM_ID = 'fc_fake_1';

type EventBody = { type: string; [key: string]: unknown };

export const numberedFrames = (events: readonly EventBody[]): FakeSseFrame[] =>
  events.map((event, index) => ({ event: event.type, data: { ...event, sequence_number: index } }));

const inProgress = () => responseResource({ id: RESPONSE_ID, model: MODEL, status: 'in_progress' });

export const openingEvents = (): EventBody[] => [
  { type: 'response.created', response: inProgress() },
  { type: 'response.in_progress', response: inProgress() },
];

export const messageEvents = (chunks: readonly string[], status: 'completed' | 'incomplete' = 'completed'): { events: EventBody[]; item: unknown } => {
  const text = chunks.join('');
  const item = { type: 'message', id: MESSAGE_ID, status, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  return {
    item,
    events: [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: MESSAGE_ID, status: 'in_progress', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', item_id: MESSAGE_ID, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      ...chunks.map((delta) => ({ type: 'response.output_text.delta', item_id: MESSAGE_ID, output_index: 0, content_index: 0, delta })),
      { type: 'response.output_text.done', item_id: MESSAGE_ID, output_index: 0, content_index: 0, text },
      { type: 'response.content_part.done', item_id: MESSAGE_ID, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
    ],
  };
};

export const refusalEvents = (refusal: string): { events: EventBody[]; item: unknown } => {
  const item = { type: 'message', id: MESSAGE_ID, status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal }] };
  return {
    item,
    events: [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: MESSAGE_ID, status: 'in_progress', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', item_id: MESSAGE_ID, output_index: 0, content_index: 0, part: { type: 'refusal', refusal: '' } },
      { type: 'response.refusal.delta', item_id: MESSAGE_ID, output_index: 0, content_index: 0, delta: refusal },
      { type: 'response.refusal.done', item_id: MESSAGE_ID, output_index: 0, content_index: 0, refusal },
      { type: 'response.content_part.done', item_id: MESSAGE_ID, output_index: 0, content_index: 0, part: { type: 'refusal', refusal } },
      { type: 'response.output_item.done', output_index: 0, item },
    ],
  };
};

export const functionCallEvents = (
  callId: string,
  name: string,
  fragments: readonly string[],
  outputIndex = 0,
): { events: EventBody[]; item: unknown } => {
  const args = fragments.join('');
  const item = { type: 'function_call', id: CALL_ITEM_ID, call_id: callId, name, arguments: args, status: 'completed' };
  return {
    item,
    events: [
      { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } },
      ...fragments.map((delta) => ({ type: 'response.function_call_arguments.delta', item_id: CALL_ITEM_ID, output_index: outputIndex, delta })),
      { type: 'response.function_call_arguments.done', item_id: CALL_ITEM_ID, output_index: outputIndex, arguments: args },
      { type: 'response.output_item.done', output_index: outputIndex, item },
    ],
  };
};

export type TerminalSpec =
  | { kind: 'completed'; usage?: Usage | null }
  | { kind: 'incomplete'; reason: string; usage?: Usage | null }
  | { kind: 'failed'; code: string; message: string; errorType?: string };

const resourceWithOptionalUsage = (input: Omit<ResponseResourceInput, 'usage'>, usage: Usage | null | undefined): Record<string, unknown> => {
  const resource: Record<string, unknown> = { ...responseResource({ ...input, ...(usage === undefined ? {} : { usage }) }) };
  if (usage === undefined) delete resource['usage'];
  return resource;
};

export const terminalEvent = (spec: TerminalSpec, output: readonly unknown[]): EventBody => {
  const base = { id: RESPONSE_ID, model: MODEL, output: output as never };
  if (spec.kind === 'completed') {
    return { type: 'response.completed', response: resourceWithOptionalUsage({ ...base, status: 'completed', completedAt: 1_800_000_001 }, spec.usage) };
  }
  if (spec.kind === 'incomplete') {
    return {
      type: 'response.incomplete',
      response: {
        ...resourceWithOptionalUsage({ ...base, status: 'incomplete', completedAt: 1_800_000_001 }, spec.usage),
        incomplete_details: { reason: spec.reason },
      },
    };
  }
  return {
    type: 'response.failed',
    response: {
      ...responseResource({ ...base, status: 'failed', completedAt: 1_800_000_001 }),
      error: { code: spec.code, message: spec.message, ...(spec.errorType === undefined ? {} : { type: spec.errorType }) },
    },
  };
};

export const DONE_FRAME: FakeSseFrame = { data: '[DONE]' };

export const openResponsesStream = (events: readonly EventBody[], options: { trailer?: 'end' | 'reset'; done?: boolean } = {}): FakeUpstreamReply => ({
  kind: 'stream',
  frames: [...numberedFrames(events), ...(options.done === false ? [] : [DONE_FRAME])],
  ...(options.trailer === undefined ? {} : { trailer: options.trailer }),
});

export const openResponsesTextReply = (chunks: readonly string[], usage?: Usage | null): FakeUpstreamReply => {
  const message = messageEvents(chunks);
  return openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'completed', ...(usage === undefined ? {} : { usage }) }, [message.item])]);
};

export const openResponsesToolCallReply = (callId: string, name: string, fragments: readonly string[]): FakeUpstreamReply => {
  const call = functionCallEvents(callId, name, fragments);
  return openResponsesStream([...openingEvents(), ...call.events, terminalEvent({ kind: 'completed' }, [call.item])]);
};

export const openResponsesErrorFrame = (type: string, code: string | null, message: string): EventBody => ({
  type: 'error',
  error: { type, code, message, param: null },
});
