import { isRecord, parseRetryAfter, parseShouldRetry } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { readTextLimited } from './body-reading.ts';
import { UpstreamHttpError } from './failures.ts';
import { usableUpstreamJson } from './upstream-json.ts';
import type { CompletionResponse } from './http-client.ts';
import { MAX_ERROR_BODY_BYTES } from './limits.ts';
import type { ErrorVocabulary } from './vocabulary.ts';

export type UpstreamErrorDetail = { code?: string | null; message?: string };

export type ErrorDetailReader = (parsed: unknown) => UpstreamErrorDetail;

export const httpErrorOf = async (
  response: CompletionResponse,
  clock: Clock,
  readDetail: ErrorDetailReader,
  vocabulary: ErrorVocabulary,
): Promise<UpstreamHttpError> => {
  const { text } = await readTextLimited(response.body, MAX_ERROR_BODY_BYTES);
  const parsed = usableUpstreamJson(text);
  const detail = readDetail(parsed);
  const kind = vocabulary.kindOf(response.status, parsed);
  const message = detail.message ?? text;
  return new UpstreamHttpError(
    response.status,
    detail.code ?? null,
    message === '' ? `HTTP ${response.status}` : message,
    retryAfterOf(response, clock),
    kind === 'guardrail',
    parseShouldRetry(response.headers['x-should-retry']),
    kind === 'context_overflow',
    kind === 'unsupported',
  );
};

export const retryAfterOf = (response: { headers: Record<string, string> }, clock: Clock): number | undefined =>
  parseRetryAfter(response.headers['retry-after'], clock.now());

export const retryAfterHint = (response: { headers: Record<string, string> }, clock: Clock): { retryAfterMs?: number } => {
  const retryAfterMs = retryAfterOf(response, clock);
  return retryAfterMs === undefined ? {} : { retryAfterMs };
};

export const nestedErrorDetail: ErrorDetailReader = (parsed) => {
  const detail = isRecord(parsed) ? parsed['error'] : undefined;
  if (!isRecord(detail)) return {};
  return {
    ...(typeof detail['message'] === 'string' ? { message: detail['message'] } : {}),
    ...(typeof detail['code'] === 'string' ? { code: detail['code'] } : {}),
  };
};
