import { TRANSIENT_REQUEST_STATUSES, findOutboundError, isRetryableHttp } from '@momonga/foundation';
import type { OutboundConnectionError } from '@momonga/foundation';
import { PRECONDITION_FAILED_CODE, TARGET_NOT_READY } from '@momonga/protocol';
import type { ClassifiedError, ErrorBody, ErrorMatch, ErrorRule, ErrorRules } from '@momonga/protocol';
import { preconditionText } from '../../precondition-text.ts';
import { retryableFailureOf } from '../../core/breaker-verdict.ts';
import {
  CONTEXT_WINDOW_EXCEEDED,
  CompactionReplyError,
  GUARDRAIL_VIOLATION,
  PreconditionFailedError,
  TargetNotReadyError,
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

const isRawConnectionFailure = (error: unknown): boolean => isStall(error) || carriesCode(CONNECTION_CODES, error, 0);

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

type UpstreamFacts = { status: number | null; code: string | null };

const ruleFor = (rules: ErrorRules, facts: UpstreamFacts): { rule: ErrorRule; by: ErrorMatch['kind'] } | undefined => {
  const { code, status } = facts;
  const byCode = code === null ? undefined : rules.find((rule) => rule.match.kind === 'code' && rule.match.codes.includes(code));
  if (byCode !== undefined) return { rule: byCode, by: 'code' };
  const byStatus = status === null ? undefined : rules.find((rule) => rule.match.kind === 'status' && rule.match.status === status);
  return byStatus === undefined ? undefined : { rule: byStatus, by: 'status' };
};

const ruleMessage = (rule: ErrorRule, by: ErrorMatch['kind'], code: string | null, requestIds: Record<string, string>): string => {
  const upstreamCode = by === 'status' && code !== null ? ` (upstream code ${code})` : '';
  const [requestId] = Object.values(requestIds);
  return `${rule.message}${upstreamCode}.${requestId === undefined ? '' : ` Request id: ${requestId}`}`;
};

const ruledError = (matched: { rule: ErrorRule; by: ErrorMatch['kind'] }, facts: UpstreamFacts, requestIds: Record<string, string>, param: string | null): ClassifiedError => {
  const { rule, by } = matched;
  return {
    retryable: rule.retryable,
    verdict: rule.verdict,
    fallback: rule.fallback,
    credential: rule.credential,
    error: body(rule.type, rule.code, ruleMessage(rule, by, facts.code, requestIds), rule.keepParam === true ? param : null),
  };
};

const retryAfterOf = (error: UpstreamHttpError): { retryAfterMs?: number } => (error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs });

const classifyUpstreamHttp = (error: UpstreamHttpError, rules: ErrorRules): ClassifiedError => {
  const facts: UpstreamFacts = { status: error.status, code: error.upstreamCode };
  const { shape } = error;
  const matched = ruleFor(rules, facts);
  const classified = matched === undefined ? classifyHttp(error) : { ...ruledError(matched, facts, shape?.requestIds ?? {}, shape?.param ?? null), ...retryAfterOf(error) };
  if (shape === undefined) return classified;
  return { ...classified, upstream: { status: error.status, bodyKeys: shape.bodyKeys, code: error.upstreamCode, requestIds: shape.requestIds } };
};

const classifyStream = (error: StreamFailure, rules: ErrorRules): ClassifiedError => {
  const facts: UpstreamFacts = { status: null, code: error.code === '' ? null : error.code };
  const matched = ruleFor(rules, facts);
  if (matched !== undefined) return ruledError(matched, facts, {}, null);
  return { retryable: retryableFailureOf(error.errorType, error.code), error: body(error.errorType, error.code, error.message) };
};

export const createUpstreamClassifier =
  (label: string, rules: ErrorRules = []) =>
  (error: unknown): ClassifiedError => {
    if (error instanceof UpstreamHttpError) return classifyUpstreamHttp(error, rules);
    if (error instanceof CompactionReplyError) {
      return { retryable: error.retryable, error: body('model_error', error.code, error.message) };
    }
    if (error instanceof UpstreamStall) {
      return { retryable: true, stalled: true, error: body(error.errorType, error.code, error.message) };
    }
    if (error instanceof StreamFailure) return classifyStream(error, rules);
    if (error instanceof TargetNotReadyError) {
      return { retryable: false, error: body('invalid_request', TARGET_NOT_READY, error.message) };
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
        ...(isStall(outbound) ? { stalled: true as const } : {}),
        error: transient
          ? body('server_error', 'provider_unavailable', `the ${label} upstream is unreachable: ${outbound.message}`)
          : body('server_error', OUTBOUND_CODES[outbound.failure.kind], `the ${label} upstream failed: ${outbound.message}`),
      };
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
