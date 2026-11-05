import { isRecord, parseRetryAfter } from '@momonga/foundation';
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
  const shouldRetry = response.headers['x-should-retry'];
  return new UpstreamHttpError(
    response.status,
    detail.code ?? null,
    message === '' ? `HTTP ${response.status}` : message,
    parseRetryAfter(response.headers['retry-after'], clock.now()),
    kind === 'guardrail',
    shouldRetry === 'false' ? false : undefined,
    kind === 'context_overflow',
    kind === 'unsupported',
  );
};

export const nestedErrorDetail: ErrorDetailReader = (parsed) => {
  const detail = isRecord(parsed) ? parsed['error'] : undefined;
  if (!isRecord(detail)) return {};
  return {
    ...(typeof detail['message'] === 'string' ? { message: detail['message'] } : {}),
    ...(typeof detail['code'] === 'string' ? { code: detail['code'] } : {}),
  };
};
