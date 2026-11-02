import { isRecord } from '@momonga/foundation';
import { UpstreamProtocolError } from '../shared/failures.ts';

export type AnthropicUsageFields = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicContentBlock = { raw: Record<string, unknown> } & (
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string }
  | { kind: 'thinking' }
  | { kind: 'other' }
);

export type AnthropicDelta =
  | { kind: 'text'; text: string }
  | { kind: 'input_json'; partialJson: string }
  | { kind: 'thinking'; thinking: string }
  | { kind: 'signature'; signature: string }
  | { kind: 'citation'; citation: unknown }
  | { kind: 'other' };

export type AnthropicStreamEvent =
  | { type: 'ping' }
  | { type: 'message_start'; usage: AnthropicUsageFields }
  | { type: 'content_block_start'; index: number; block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; stopReason: string | undefined; usage: AnthropicUsageFields }
  | { type: 'message_stop' }
  | { type: 'error'; errorType: string; message: string }
  | { type: 'unknown'; name: string };

const invalid = (what: string): UpstreamProtocolError => new UpstreamProtocolError(`the upstream sent a malformed event: ${what}`);

const requiredString = (container: Record<string, unknown>, key: string, what: string): string => {
  const value = container[key];
  if (typeof value !== 'string') throw invalid(`${what}.${key} must be a string`);
  return value;
};

const blockIndex = (event: Record<string, unknown>): number => {
  const { index } = event;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw invalid('index must be a non-negative integer');
  return index;
};

const tokenField = (container: Record<string, unknown>, key: keyof AnthropicUsageFields): number | undefined => {
  const value = container[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`usage.${key} must be a non-negative integer`);
  return value;
};

const usageOf = (value: unknown): AnthropicUsageFields => {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalid('usage must be an object');
  const fields: AnthropicUsageFields = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const token = tokenField(value, key);
    if (token !== undefined) fields[key] = token;
  }
  return fields;
};

const blockOf = (value: unknown): AnthropicContentBlock => {
  if (!isRecord(value)) throw invalid('content_block must be an object');
  const type = requiredString(value, 'type', 'content_block');
  if (type === 'text') return { raw: value, kind: 'text', text: typeof value['text'] === 'string' ? value['text'] : '' };
  if (type === 'tool_use') {
    return { raw: value, kind: 'tool_use', id: requiredString(value, 'id', 'content_block'), name: requiredString(value, 'name', 'content_block') };
  }
  if (type === 'thinking' || type === 'redacted_thinking') return { raw: value, kind: 'thinking' };
  return { raw: value, kind: 'other' };
};

const deltaOf = (value: unknown): AnthropicDelta => {
  if (!isRecord(value)) throw invalid('delta must be an object');
  const type = requiredString(value, 'type', 'delta');
  if (type === 'text_delta') return { kind: 'text', text: requiredString(value, 'text', 'delta') };
  if (type === 'input_json_delta') return { kind: 'input_json', partialJson: requiredString(value, 'partial_json', 'delta') };
  if (type === 'thinking_delta') return { kind: 'thinking', thinking: requiredString(value, 'thinking', 'delta') };
  if (type === 'signature_delta') return { kind: 'signature', signature: requiredString(value, 'signature', 'delta') };
  if (type === 'citations_delta') return { kind: 'citation', citation: value['citation'] };
  return { kind: 'other' };
};

export const parseAnthropicEvent = (data: string): AnthropicStreamEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw invalid('it is not valid JSON');
  }
  if (!isRecord(parsed)) throw invalid('it is not a JSON object');
  const type = requiredString(parsed, 'type', 'event');
  switch (type) {
    case 'ping':
      return { type };
    case 'message_start': {
      const message = parsed['message'];
      if (!isRecord(message)) throw invalid('message_start.message must be an object');
      return { type, usage: usageOf(message['usage']) };
    }
    case 'content_block_start':
      return { type, index: blockIndex(parsed), block: blockOf(parsed['content_block']) };
    case 'content_block_delta':
      return { type, index: blockIndex(parsed), delta: deltaOf(parsed['delta']) };
    case 'content_block_stop':
      return { type, index: blockIndex(parsed) };
    case 'message_delta': {
      const delta = parsed['delta'];
      if (!isRecord(delta)) throw invalid('message_delta.delta must be an object');
      const stopReason = delta['stop_reason'];
      if (stopReason !== undefined && stopReason !== null && typeof stopReason !== 'string') throw invalid('message_delta.delta.stop_reason must be a string');
      return { type, stopReason: stopReason ?? undefined, usage: usageOf(parsed['usage']) };
    }
    case 'message_stop':
      return { type };
    case 'error': {
      const error = parsed['error'];
      if (!isRecord(error)) throw invalid('error.error must be an object');
      return { type, errorType: requiredString(error, 'type', 'error.error'), message: requiredString(error, 'message', 'error.error') };
    }
    default:
      return { type: 'unknown', name: type };
  }
};
