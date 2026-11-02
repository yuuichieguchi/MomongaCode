import type { FakeSseFrame, FakeUpstreamReply, FakeUpstreamServer } from './fake-sse-upstream.ts';
import { startFakeSseUpstream } from './fake-sse-upstream.ts';

export const FAKE_ANTHROPIC_VERSION = '2023-06-01';
export const FAKE_ANTHROPIC_PATH = '/v1/messages';

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
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.respond === undefined ? {} : { respond: options.respond }),
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    authenticate: (headers) => {
      if (headers['x-api-key'] !== options.apiKey) return anthropicErrorReply(401, 'authentication_error', 'invalid x-api-key');
      if (headers['anthropic-version'] !== FAKE_ANTHROPIC_VERSION) {
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
