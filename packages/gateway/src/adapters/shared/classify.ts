import { TRANSIENT_REQUEST_STATUSES, isRetryableHttp } from '@momonga/foundation';
import { PRECONDITION_FAILED_CODE } from '@momonga/protocol';
import type { ClassifiedError, ErrorBody } from '@momonga/protocol';
import { preconditionText } from '../../precondition-text.ts';
import {
  CONTEXT_WINDOW_EXCEEDED,
  CompactionReplyError,
  GUARDRAIL_VIOLATION,
  PreconditionFailedError,
  StreamFailure,
  UNSUPPORTED_REQUEST,
  UnsupportedInputError,
  UpstreamHttpError,
  UpstreamStall,
} from './failures.ts';

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_CLOSED',
]);
const STALL_CODES: ReadonlySet<string> = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const MAX_CAUSE_DEPTH = 8;

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const carriesCode = (codes: ReadonlySet<string>, error: unknown, depth: number): boolean => {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null) return false;
  const code = codeOf(error);
  if (code === 'UND_ERR_ABORTED' || (error as { name?: unknown }).name === 'AbortError') return false;
  if (code !== undefined && codes.has(code)) return true;
  if (carriesCode(codes, (error as { cause?: unknown }).cause, depth + 1)) return true;
  const nested = (error as { errors?: unknown }).errors;
  return Array.isArray(nested) && nested.some((entry) => carriesCode(codes, entry, depth + 1));
};

const isStall = (error: unknown): boolean => carriesCode(STALL_CODES, error, 0);

export const isConnectionFailure = (error: unknown): boolean => isStall(error) || carriesCode(CONNECTION_CODES, error, 0);

const body = (type: ErrorBody['type'], code: string | null, message: string, param: string | null = null): ErrorBody => ({
  type,
  code,
  message,
  param,
});

const classifyHttp = (error: UpstreamHttpError): ClassifiedError => {
  const { status, upstreamCode, upstreamMessage } = error;
  if (error.guardrail) {
    return { retryable: false, error: body('model_error', GUARDRAIL_VIOLATION, upstreamMessage) };
  }
  if (error.contextOverflow) {
    return { retryable: false, error: body('invalid_request', CONTEXT_WINDOW_EXCEEDED, error.message) };
  }
  if (error.unsupported) {
    return { retryable: false, error: body('invalid_request', UNSUPPORTED_REQUEST, error.message) };
  }
  const retryable = isRetryableHttp(status, error.retryHint);
  const retryAfter = error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs };
  if (status === 429) return { retryable, ...retryAfter, error: body('too_many_requests', upstreamCode, error.message) };
  if (status >= 500 || TRANSIENT_REQUEST_STATUSES.includes(status)) {
    return { retryable, ...retryAfter, error: body('server_error', upstreamCode ?? 'upstream_error', error.message) };
  }
  if (status === 413) return { retryable, error: body('invalid_request', 'payload_too_large', error.message) };
  if (status === 401 || status === 403) return { retryable, error: body('invalid_request', 'authentication_failed', error.message) };
  if (status >= 400) return { retryable, error: body('invalid_request', upstreamCode, error.message) };
  return { retryable: false, error: body('server_error', 'unexpected_status', error.message) };
};

export const createUpstreamClassifier =
  (label: string) =>
  (error: unknown): ClassifiedError => {
    if (error instanceof UpstreamHttpError) return classifyHttp(error);
    if (error instanceof CompactionReplyError) {
      return { retryable: error.retryable, error: body('model_error', error.code, error.message) };
    }
    if (error instanceof UpstreamStall) {
      return { retryable: true, stalled: true, error: body(error.errorType, error.code, error.message) };
    }
    if (error instanceof StreamFailure) {
      return { retryable: error.errorType !== 'invalid_request' && error.errorType !== 'not_found' && error.code !== GUARDRAIL_VIOLATION, error: body(error.errorType, error.code, error.message) };
    }
    if (error instanceof PreconditionFailedError) {
      return { retryable: false, error: body('invalid_request', PRECONDITION_FAILED_CODE, preconditionText(error.message, error.detail, error.remediation)) };
    }
    if (error instanceof UnsupportedInputError) {
      return { retryable: false, error: body('invalid_request', error.code, error.message, error.param) };
    }
    if (isConnectionFailure(error)) {
      return {
        retryable: true,
        ...(isStall(error) ? { stalled: true as const } : {}),
        error: body('server_error', 'provider_unavailable', `the ${label} upstream is unreachable`),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { retryable: false, error: body('server_error', 'adapter_error', message) };
  };
