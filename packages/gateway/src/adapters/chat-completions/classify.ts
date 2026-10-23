import type { ClassifiedError, ErrorBody } from '@momonga/protocol';
import { UnsupportedInputError, UpstreamHttpError } from './failures.ts';

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
]);
const MAX_CAUSE_DEPTH = 8;

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const isConnectionFailure = (error: unknown, depth = 0): boolean => {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null) return false;
  const code = codeOf(error);
  if (code === 'UND_ERR_ABORTED' || (error as { name?: unknown }).name === 'AbortError') return false;
  if (code !== undefined && CONNECTION_CODES.has(code)) return true;
  if (isConnectionFailure((error as { cause?: unknown }).cause, depth + 1)) return true;
  const nested = (error as { errors?: unknown }).errors;
  return Array.isArray(nested) && nested.some((entry) => isConnectionFailure(entry, depth + 1));
};

const errorFieldOf = (body: unknown, field: 'code' | 'type'): unknown => {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[field];
};

const body = (type: ErrorBody['type'], code: string | null, message: string, param: string | null = null): ErrorBody => ({
  type,
  code,
  message,
  param,
});

const classifyHttp = (error: UpstreamHttpError): ClassifiedError => {
  const { status, upstreamCode, upstreamMessage } = error;
  if (status === 429) {
    return {
      retryable: true,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      error: body('too_many_requests', upstreamCode, error.message),
    };
  }
  if (status >= 500) return { retryable: true, error: body('server_error', upstreamCode ?? 'upstream_error', error.message) };
  if (status === 413) return { retryable: false, error: body('invalid_request', 'payload_too_large', error.message) };
  if (error.guardrail) {
    return { retryable: false, error: body('model_error', 'guardrail_violation', upstreamMessage) };
  }
  if (status >= 400) {
    return { retryable: false, error: body('invalid_request', upstreamCode, error.message) };
  }
  return { retryable: false, error: body('server_error', 'unexpected_status', error.message) };
};

export const classifyChatCompletionsError = (error: unknown): ClassifiedError => {
  if (error instanceof UpstreamHttpError) return classifyHttp(error);
  if (error instanceof UnsupportedInputError) {
    return { retryable: false, error: body('invalid_request', error.code, error.message, error.param) };
  }
  if (isConnectionFailure(error)) {
    return {
      retryable: true,
      error: body('server_error', 'provider_unavailable', 'the chat-completions upstream is unreachable'),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { retryable: false, error: body('server_error', 'adapter_error', message) };
};

export const matchesGuardrailCode = (body: unknown): boolean => errorFieldOf(body, 'code') === 'guardrail_violation';
