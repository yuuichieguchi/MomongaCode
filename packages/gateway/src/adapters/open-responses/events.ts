import { ERROR_TYPES, cachedDetailOf } from '@momonga/protocol';
import type { ErrorType, Usage } from '@momonga/protocol';
import { UpstreamProtocolError } from '../shared/failures.ts';
import { parseUpstreamJson } from '../shared/upstream-json.ts';
import { isRecord } from '@momonga/foundation';

export type UpstreamItem =
  | { kind: 'message'; text: string; refusal: string }
  | { kind: 'function_call'; callId: string; name: string; arguments: string }
  | { kind: 'reasoning'; content: string[]; summary: string[]; encryptedContent: string | undefined }
  | { kind: 'other' };

export type UpstreamTerminal =
  | { status: 'completed'; usage: Usage | undefined }
  | { status: 'incomplete'; reason: string | undefined; usage: Usage | undefined }
  | { status: 'failed'; code: string; message: string; errorType: ErrorType };

export type OpenResponsesStreamEvent =
  | { type: 'opening' }
  | { type: 'item_added'; outputIndex: number; item: UpstreamItem }
  | { type: 'item_done'; outputIndex: number; item: UpstreamItem }
  | { type: 'text_delta'; outputIndex: number; delta: string }
  | { type: 'refusal_delta'; outputIndex: number; delta: string }
  | { type: 'arguments_delta'; outputIndex: number; delta: string }
  | { type: 'reasoning_delta'; outputIndex: number; contentIndex: number; delta: string }
  | { type: 'reasoning_summary_delta'; outputIndex: number; summaryIndex: number; delta: string }
  | { type: 'terminal'; terminal: UpstreamTerminal }
  | { type: 'error'; code: string; message: string; errorType: ErrorType }
  | { type: 'ignored' };

const invalid = (what: string): UpstreamProtocolError => new UpstreamProtocolError(`the upstream sent a malformed event: ${what}`);

const requiredString = (container: Record<string, unknown>, key: string, what: string): string => {
  const value = container[key];
  if (typeof value !== 'string') throw invalid(`${what}.${key} must be a string`);
  return value;
};

const optionalString = (container: Record<string, unknown>, key: string, what: string): string | undefined => {
  const value = container[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${what}.${key} must be a string`);
  return value;
};

const outputIndexOf = (event: Record<string, unknown>): number => {
  const { output_index: index } = event;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw invalid('output_index must be a non-negative integer');
  return index;
};

const partIndexOf = (event: Record<string, unknown>, key: string): number => {
  const index = event[key];
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw invalid(`${key} must be a non-negative integer`);
  return index;
};

const textPartsOf = (container: Record<string, unknown>, key: string, partType: string): string[] => {
  const parts = container[key];
  if (parts === undefined || parts === null) return [];
  if (!Array.isArray(parts)) throw invalid(`item.${key} must be an array`);
  return parts.flatMap((part): string[] => {
    if (!isRecord(part)) throw invalid(`item.${key} parts must be objects`);
    return part['type'] === partType ? [requiredString(part, 'text', 'reasoning part')] : [];
  });
};

const tokenCount = (container: Record<string, unknown>, key: string, what: string): number => {
  const value = container[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`${what}.${key} must be a non-negative integer`);
  return value;
};

const reportedDetail = (container: Record<string, unknown>, group: string, key: string): number | undefined => {
  const details = container[group];
  if (details === undefined || details === null) return undefined;
  if (!isRecord(details)) throw invalid(`usage.${group} must be an object`);
  const value = details[key];
  return value === undefined || value === null ? undefined : tokenCount(details, key, `usage.${group}`);
};

const usageOf = (value: unknown): Usage | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalid('usage must be an object');
  const input = tokenCount(value, 'input_tokens', 'usage');
  const output = tokenCount(value, 'output_tokens', 'usage');
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: cachedDetailOf(reportedDetail(value, 'input_tokens_details', 'cached_tokens')),
    output_tokens_details: { reasoning_tokens: reportedDetail(value, 'output_tokens_details', 'reasoning_tokens') ?? 0 },
  };
};

const errorTypeOf = (value: unknown): ErrorType => {
  const known = ERROR_TYPES.find((type) => type === value);
  return known ?? 'server_error';
};

const itemOf = (value: unknown): UpstreamItem => {
  if (!isRecord(value)) throw invalid('item must be an object');
  const type = requiredString(value, 'type', 'item');
  if (type === 'function_call') {
    return {
      kind: 'function_call',
      callId: requiredString(value, 'call_id', 'item'),
      name: requiredString(value, 'name', 'item'),
      arguments: optionalString(value, 'arguments', 'item') ?? '',
    };
  }
  if (type === 'reasoning') {
    return {
      kind: 'reasoning',
      content: textPartsOf(value, 'content', 'reasoning_text'),
      summary: textPartsOf(value, 'summary', 'summary_text'),
      encryptedContent: optionalString(value, 'encrypted_content', 'item'),
    };
  }
  if (type !== 'message') return { kind: 'other' };
  const content = value['content'];
  let text = '';
  let refusal = '';
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) throw invalid('message content parts must be objects');
      if (part['type'] === 'output_text') text += requiredString(part, 'text', 'content part');
      else if (part['type'] === 'refusal') refusal += requiredString(part, 'refusal', 'content part');
    }
  }
  return { kind: 'message', text, refusal };
};

const terminalOf = (type: string, response: unknown): UpstreamTerminal => {
  if (!isRecord(response)) throw invalid(`${type}.response must be an object`);
  if (type === 'response.completed') return { status: 'completed', usage: usageOf(response['usage']) };
  if (type === 'response.incomplete') {
    const details = response['incomplete_details'];
    const reason = isRecord(details) ? optionalString(details, 'reason', 'incomplete_details') : undefined;
    return { status: 'incomplete', reason, usage: usageOf(response['usage']) };
  }
  const error = response['error'];
  if (!isRecord(error)) throw invalid('response.failed carries no error object');
  return {
    status: 'failed',
    code: requiredString(error, 'code', 'response.error'),
    message: requiredString(error, 'message', 'response.error'),
    errorType: errorTypeOf(error['type']),
  };
};

export const parseOpenResponsesEvent = (data: string): OpenResponsesStreamEvent => {
  const parsed = parseUpstreamJson(data, invalid);
  if (!isRecord(parsed)) throw invalid('it is not a JSON object');
  const type = requiredString(parsed, 'type', 'event');
  switch (type) {
    case 'response.created':
    case 'response.queued':
    case 'response.in_progress':
      return { type: 'opening' };
    case 'response.output_item.added':
      return { type: 'item_added', outputIndex: outputIndexOf(parsed), item: itemOf(parsed['item']) };
    case 'response.output_item.done':
      return { type: 'item_done', outputIndex: outputIndexOf(parsed), item: itemOf(parsed['item']) };
    case 'response.output_text.delta':
      return { type: 'text_delta', outputIndex: outputIndexOf(parsed), delta: requiredString(parsed, 'delta', 'event') };
    case 'response.refusal.delta':
      return { type: 'refusal_delta', outputIndex: outputIndexOf(parsed), delta: requiredString(parsed, 'delta', 'event') };
    case 'response.reasoning.delta':
      return {
        type: 'reasoning_delta',
        outputIndex: outputIndexOf(parsed),
        contentIndex: partIndexOf(parsed, 'content_index'),
        delta: requiredString(parsed, 'delta', 'event'),
      };
    case 'response.reasoning_summary_text.delta':
      return {
        type: 'reasoning_summary_delta',
        outputIndex: outputIndexOf(parsed),
        summaryIndex: partIndexOf(parsed, 'summary_index'),
        delta: requiredString(parsed, 'delta', 'event'),
      };
    case 'response.function_call_arguments.delta':
      return { type: 'arguments_delta', outputIndex: outputIndexOf(parsed), delta: requiredString(parsed, 'delta', 'event') };
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      return { type: 'terminal', terminal: terminalOf(type, parsed['response']) };
    case 'error': {
      const error = parsed['error'];
      if (!isRecord(error)) throw invalid('error.error must be an object');
      return {
        type: 'error',
        code: optionalString(error, 'code', 'error.error') ?? 'upstream_error',
        message: requiredString(error, 'message', 'error.error'),
        errorType: errorTypeOf(error['type']),
      };
    }
    default:
      return { type: 'ignored' };
  }
};
