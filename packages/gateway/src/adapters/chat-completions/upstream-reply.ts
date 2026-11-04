import { decodeSse, isRecord } from '@momonga/foundation';
import type { SseEvent } from '@momonga/foundation';
import { CONTEXT_WINDOW_EXCEEDED, StreamFailure, UNSUPPORTED_REQUEST } from '../shared/failures.ts';
import type { ErrorVocabulary } from './vocabulary.ts';

const ERROR_EVENT = 'error';
const DONE_MARKER = '[DONE]';
const UNNAMED_UPSTREAM_ERROR = 'upstream_error';

export type UpstreamReply =
  | { kind: 'completion'; usage: Record<string, unknown> | undefined }
  | { kind: 'error'; status: number; body: unknown };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

export const upstreamErrorEventBody = (event: SseEvent): { body: unknown } | undefined =>
  event.event === ERROR_EVENT ? { body: parseJson(event.data) ?? event.data } : undefined;

const usageOf = (body: unknown): Record<string, unknown> | undefined => {
  const usage = isRecord(body) ? body['usage'] : undefined;
  return isRecord(usage) ? usage : undefined;
};

async function* textSource(text: string): AsyncGenerator<string> {
  yield text;
}

export const decodeUpstreamReply = async (status: number, text: string): Promise<UpstreamReply> => {
  if (status >= 400) return { kind: 'error', status, body: parseJson(text) ?? text };
  const json = parseJson(text);
  if (json !== undefined) return { kind: 'completion', usage: usageOf(json) };
  let usage: Record<string, unknown> | undefined;
  for await (const event of decodeSse(textSource(text))) {
    const failure = upstreamErrorEventBody(event);
    if (failure !== undefined) return { kind: 'error', status, body: failure.body };
    if (event.data === DONE_MARKER) break;
    usage = usageOf(parseJson(event.data)) ?? usage;
  }
  return { kind: 'completion', usage };
};

export const upstreamErrorMessage = (body: unknown): string => {
  const error = isRecord(body) ? body['error'] : undefined;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  return typeof body === 'string' ? body : JSON.stringify(body);
};

export const upstreamErrorFailure = (vocabulary: ErrorVocabulary, status: number, body: unknown): StreamFailure => {
  const message = upstreamErrorMessage(body);
  const kind = vocabulary.kindOf(status, body);
  if (kind === 'context_overflow') return new StreamFailure(CONTEXT_WINDOW_EXCEEDED, 'invalid_request', message);
  if (kind === 'unsupported') return new StreamFailure(UNSUPPORTED_REQUEST, 'invalid_request', message);
  const error = isRecord(body) ? body['error'] : undefined;
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : UNNAMED_UPSTREAM_ERROR;
  return new StreamFailure(code, 'server_error', message);
};
