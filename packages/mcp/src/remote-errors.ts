import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';

export type RemotePolicyViolation =
  | 'scheme'
  | 'credentials_in_url'
  | 'non_public_address_literal'
  | 'loopback_hostname'
  | 'non_public_resolved_address'
  | 'unresolvable_host'
  | 'authorization_url_scheme';

export class McpRemotePolicyError extends Error {
  readonly violation: RemotePolicyViolation;

  constructor(violation: RemotePolicyViolation, message: string) {
    super(message);
    this.name = 'McpRemotePolicyError';
    this.violation = violation;
  }
}

export type AuthorizationFailure = 'required' | 'denied' | 'timed_out' | 'invalid_callback';

export class McpAuthorizationError extends Error {
  readonly failure: AuthorizationFailure;

  constructor(failure: AuthorizationFailure, message: string) {
    super(message);
    this.name = 'McpAuthorizationError';
    this.failure = failure;
  }
}

export class McpTaskError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message);
    this.name = 'McpTaskError';
    this.taskId = taskId;
  }
}

const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const TRANSIENT_SOCKET_CODES: ReadonlySet<string> = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

const causeCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
};

export const isTransientRemoteFailure = (error: unknown): boolean => {
  if (error instanceof SdkHttpError) return TRANSIENT_HTTP_STATUSES.has(error.status);
  if (error instanceof SdkError) return false;
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const code = causeCode(error);
    return code !== undefined && TRANSIENT_SOCKET_CODES.has(code);
  }
  return false;
};

export const isSessionExpired = (error: unknown): boolean => error instanceof SdkHttpError && error.status === 404;

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof SdkHttpError && error.code === SdkErrorCode.ClientHttpAuthentication;
