import { TRANSIENT_REQUEST_STATUSES, findOutboundError, isRetryableHttp } from '@momonga/foundation';
import type { OutboundConnectionError } from '@momonga/foundation';
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
} from './failures.ts';

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

const PROXY_REFUSAL_TRANSIENT_STATUS = 500;

const isTransientOutbound = (error: OutboundConnectionError): boolean =>
  error.failure.kind === 'proxy-unreachable' ||
  (error.failure.kind === 'proxy-refused' && error.failure.status >= PROXY_REFUSAL_TRANSIENT_STATUS) ||
  (error.failure.kind === 'origin-connection' && isRawConnectionFailure(error.cause));

const OUTBOUND_CODES: Readonly<Record<OutboundConnectionError['failure']['kind'], string>> = {
  'proxy-unreachable': 'provider_unavailable',
  'proxy-refused': 'proxy_refused',
  'proxy-auth': 'proxy_authentication_required',
  'proxy-tls': 'proxy_tls_failed',
  'proxy-unsupported': 'proxy_unsupported',
  'origin-certificate': 'certificate_untrusted',
  'ca-file': 'ca_file_unreadable',
  'origin-connection': 'adapter_error',
};

export const isConnectionFailure = (error: unknown): boolean => {
  const outbound = findOutboundError(error);
  return outbound === undefined ? isRawConnectionFailure(error) : isTransientOutbound(outbound);
};

function isRawConnectionFailure(error: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null) return false;
  const code = codeOf(error);
  if (code === 'UND_ERR_ABORTED' || (error as { name?: unknown }).name === 'AbortError') return false;
  if (code !== undefined && CONNECTION_CODES.has(code)) return true;
  if (isRawConnectionFailure((error as { cause?: unknown }).cause, depth + 1)) return true;
  const nested = (error as { errors?: unknown }).errors;
  return Array.isArray(nested) && nested.some((entry) => isRawConnectionFailure(entry, depth + 1));
}

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
    if (error instanceof StreamFailure) {
      return { retryable: error.errorType !== 'invalid_request' && error.errorType !== 'not_found' && error.code !== GUARDRAIL_VIOLATION, error: body(error.errorType, error.code, error.message) };
    }
    if (error instanceof PreconditionFailedError) {
      return { retryable: false, error: body('invalid_request', PRECONDITION_FAILED_CODE, preconditionText(error.message, error.detail, error.remediation)) };
    }
    if (error instanceof UnsupportedInputError) {
      return { retryable: false, error: body('invalid_request', error.code, error.message, error.param) };
    }
    const outbound = findOutboundError(error);
    if (outbound !== undefined) {
      const transient = isTransientOutbound(outbound);
      return {
        retryable: transient,
        error: transient
          ? body('server_error', 'provider_unavailable', `the ${label} upstream is unreachable: ${outbound.message}`)
          : body('server_error', OUTBOUND_CODES[outbound.failure.kind], `the ${label} upstream failed: ${outbound.message}`),
      };
    }
    if (isConnectionFailure(error)) {
      return {
        retryable: true,
        error: body('server_error', 'provider_unavailable', `the ${label} upstream is unreachable`),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { retryable: false, error: body('server_error', 'adapter_error', message) };
  };
