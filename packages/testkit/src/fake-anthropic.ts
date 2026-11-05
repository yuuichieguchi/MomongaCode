import type { FakeSseFrame, FakeUpstreamReply, FakeUpstreamServer, RecordedUpstreamRequest } from './fake-sse-upstream.ts';
import { startFakeSseUpstream } from './fake-sse-upstream.ts';

export const FAKE_ANTHROPIC_VERSION = '2023-06-01';
export const FAKE_ANTHROPIC_VERSIONS: readonly string[] = [FAKE_ANTHROPIC_VERSION, '2026-10-21'];
export const FAKE_ANTHROPIC_PATH = '/v1/messages';
export const FAKE_ANTHROPIC_COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

const COUNT_TOKENS_FIELDS: ReadonlySet<string> = new Set(['messages', 'model', 'system', 'thinking', 'tool_choice', 'tools']);
const MAX_CACHE_BREAKPOINTS = 4;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const blocksOf = (body: Record<string, unknown>): Record<string, unknown>[] => {
  const nested = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isObject).flatMap((block) => [block, ...nested(block['content'])]) : [];
  const messages = Array.isArray(body['messages']) ? body['messages'].filter(isObject) : [];
  return [
    ...(Array.isArray(body['tools']) ? body['tools'].filter(isObject) : []),
    ...nested(body['system']),
    ...messages.flatMap((message) => nested(message['content'])),
  ];
};

const invalidRequest = (message: string): FakeUpstreamReply => anthropicErrorReply(400, 'invalid_request_error', message);

const validateAnthropicRequest = (request: RecordedUpstreamRequest): FakeUpstreamReply | undefined => {
  const { body } = request;
  if (!isObject(body)) return invalidRequest('the request body must be a JSON object');
  const counting = request.path === FAKE_ANTHROPIC_COUNT_TOKENS_PATH;
  if (typeof body['model'] !== 'string') return invalidRequest('model: Field required');
  if (!Array.isArray(body['messages'])) return invalidRequest('messages: Field required');
  if (counting) {
    const extra = Object.keys(body).find((key) => !COUNT_TOKENS_FIELDS.has(key));
    if (extra !== undefined) return invalidRequest(`${extra}: Extra inputs are not permitted`);
  } else if (typeof body['max_tokens'] !== 'number') {
    return invalidRequest('max_tokens: Field required');
  }
  if (body['system'] !== undefined && typeof body['system'] !== 'string' && !Array.isArray(body['system'])) {
    return invalidRequest('system: must be a string or an array of text blocks');
  }
  const blocks = blocksOf(body);
  if (blocks.filter((block) => block['cache_control'] !== undefined).length > MAX_CACHE_BREAKPOINTS) {
    return invalidRequest(`A maximum of ${MAX_CACHE_BREAKPOINTS} blocks with cache_control may be provided`);
  }
  if (counting && blocks.some((block) => block['type'] === 'image' && isObject(block['source']) && block['source']['type'] === 'url')) {
    return invalidRequest('image blocks with a url source cannot be counted; send the image as base64');
  }
  return undefined;
};

export type FakeAnthropicOptions = {
  apiKey: string;
  script?: FakeUpstreamReply[];
  respond?: Parameters<typeof startFakeSseUpstream>[0]['respond'];
  socketPath?: string;
};

export const anthropicErrorBody = (type: string, message: string): { type: 'error'; error: { type: string; message: string } } => ({
  type: 'error',
  error: { type, message },
});

export const anthropicErrorReply = (status: number, type: string, message: string, headers?: Record<string, string>): FakeUpstreamReply => ({
  kind: 'error',
  status,
  body: anthropicErrorBody(type, message),
  ...(headers === undefined ? {} : { headers }),
});

export const startFakeAnthropic = (options: FakeAnthropicOptions): Promise<FakeUpstreamServer> =>
  startFakeSseUpstream({
    path: FAKE_ANTHROPIC_PATH,
    extraPaths: [FAKE_ANTHROPIC_COUNT_TOKENS_PATH],
    validate: validateAnthropicRequest,
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.respond === undefined ? {} : { respond: options.respond }),
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    authenticate: (headers) => {
      if (headers['x-api-key'] !== options.apiKey) return anthropicErrorReply(401, 'authentication_error', 'invalid x-api-key');
      if (!FAKE_ANTHROPIC_VERSIONS.includes(String(headers['anthropic-version']))) {
        return anthropicErrorReply(400, 'invalid_request_error', 'anthropic-version header is missing or unsupported');
      }
      return undefined;
    },
  });

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

const frame = (type: string, fields: Record<string, unknown>): FakeSseFrame => ({ event: type, data: { type, ...fields } });

export const anthropicMessageStart = (usage: AnthropicUsage = {}, model = 'claude-fake'): FakeSseFrame =>
  frame('message_start', {
    message: {
      id: 'msg_fake_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 1, ...usage },
    },
  });

export const anthropicPing = (): FakeSseFrame => frame('ping', {});

export const anthropicTextBlock = (index: number, chunks: readonly string[]): FakeSseFrame[] => [
  frame('content_block_start', { index, content_block: { type: 'text', text: '' } }),
  ...chunks.map((text) => frame('content_block_delta', { index, delta: { type: 'text_delta', text } })),
  frame('content_block_stop', { index }),
];

export const anthropicToolUseBlock = (index: number, id: string, name: string, jsonFragments: readonly string[]): FakeSseFrame[] => [
  frame('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } }),
  ...jsonFragments.map((partial_json) => frame('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } })),
  frame('content_block_stop', { index }),
];

export const anthropicMessageEnd = (stopReason: string, usage: AnthropicUsage = { output_tokens: 15 }): FakeSseFrame[] => [
  frame('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage }),
  frame('message_stop', {}),
];

export const anthropicErrorEvent = (type: string, message: string): FakeSseFrame => ({
  event: 'error',
  data: anthropicErrorBody(type, message),
});

export const anthropicStream = (frames: readonly FakeSseFrame[], trailer?: 'end' | 'reset'): FakeUpstreamReply => ({
  kind: 'stream',
  frames: [...frames],
  ...(trailer === undefined ? {} : { trailer }),
});

export const anthropicTextReply = (chunks: readonly string[], usage?: AnthropicUsage): FakeUpstreamReply =>
  anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, chunks), ...anthropicMessageEnd('end_turn', usage)]);

export const anthropicToolUseReply = (id: string, name: string, jsonFragments: readonly string[]): FakeUpstreamReply =>
  anthropicStream([anthropicMessageStart(), ...anthropicToolUseBlock(0, id, name, jsonFragments), ...anthropicMessageEnd('tool_use')]);

export const anthropicCountTokensReply = (inputTokens: number): FakeUpstreamReply => ({ kind: 'json', body: { input_tokens: inputTokens } });

export const anthropicBlockStart = (index: number, contentBlock: Record<string, unknown>): FakeSseFrame =>
  frame('content_block_start', { index, content_block: contentBlock });

export const anthropicBlockDelta = (index: number, delta: Record<string, unknown>): FakeSseFrame => frame('content_block_delta', { index, delta });

export const anthropicBlockStop = (index: number): FakeSseFrame => frame('content_block_stop', { index });
