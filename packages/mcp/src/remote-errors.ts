import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { CredentialStoreError, OAuthAuthorizationError as McpAuthorizationError } from '@momonga/foundation';
import type { AuthorizationFailure } from '@momonga/foundation';

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

export { McpAuthorizationError };
export type { AuthorizationFailure };

export class McpTaskError extends Error {
  readonly taskId: string;
  cancelFailure?: unknown;

  constructor(taskId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpTaskError';
    this.taskId = taskId;
  }
}

const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const TRANSIENT_SOCKET_CODES: ReadonlySet<string> = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

const MAX_CAUSE_DEPTH = 4;

export const findInCauseChain = <T extends Error>(error: unknown, matches: (candidate: Error) => candidate is T): T | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (matches(current)) return current;
    current = current.cause;
  }
  return undefined;
};

const causeCode = (error: unknown): string | undefined => {
  const withCode = findInCauseChain(error, (candidate): candidate is Error & { code: string } => typeof (candidate as Error & { code?: unknown }).code === 'string');
  return withCode?.code;
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

export const isSessionExpired = (error: unknown): boolean =>
  findInCauseChain(error, (candidate): candidate is SdkHttpError => candidate instanceof SdkHttpError && candidate.status === 404) !== undefined;

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof SdkHttpError && error.code === SdkErrorCode.ClientHttpAuthentication;

export const authorizationRequiredFor = (error: unknown): McpAuthorizationError | undefined =>
  findInCauseChain(error, (candidate): candidate is McpAuthorizationError => candidate instanceof McpAuthorizationError && candidate.failure === 'required');

export type DeterministicRemoteFailure = McpRemotePolicyError | McpAuthorizationError | CredentialStoreError;

export const deterministicRemoteFailureOf = (error: unknown): DeterministicRemoteFailure | undefined =>
  findInCauseChain(
    error,
    (candidate): candidate is DeterministicRemoteFailure =>
      candidate instanceof McpRemotePolicyError || candidate instanceof McpAuthorizationError || candidate instanceof CredentialStoreError,
  );
