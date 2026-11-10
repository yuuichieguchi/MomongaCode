import { OperationLimitError } from './operation-limit.ts';
import type { SecretBackend } from './secret-store.ts';

export type SecretAction = 'read' | 'write';

export type SecretCall = { action: SecretAction; name: string | undefined; backend: SecretBackend | undefined };

export type NamedSecretCall = { action: SecretAction; name: string };

export type SecretStoreAbsence = { reason: string; backend?: SecretBackend | undefined; call?: NamedSecretCall | undefined };

const COULD_NOT_BE: Readonly<Record<SecretAction, string>> = { read: 'read', write: 'written' };

const noStoreText = (reason: string): string => `no secret store was found on this host (${reason})`;

const readinessAdviceOf = (backend: SecretBackend | undefined, call: NamedSecretCall): string => {
  const advice = backend?.readiness?.advice;
  if (backend === undefined || advice === undefined) return '';
  return call.action === 'read' ? `; ${advice}, then store it with: ${backend.storeCommand(call.name)}` : `; ${advice}`;
};

const absenceText = ({ reason, backend, call }: SecretStoreAbsence): string =>
  call === undefined ? noStoreText(reason) : `the secret "${call.name}" could not be ${COULD_NOT_BE[call.action]}: ${noStoreText(reason)}${readinessAdviceOf(backend, call)}`;

export class SecretStoreAbsentError extends Error {
  readonly reason: string;
  readonly backend: SecretBackend | undefined;
  readonly call: NamedSecretCall | undefined;

  constructor(absence: SecretStoreAbsence) {
    super(absenceText(absence));
    this.name = 'SecretStoreAbsentError';
    this.reason = absence.reason;
    this.backend = absence.backend;
    this.call = absence.call;
  }
}

export class SecretStoreAnswerError extends Error {
  readonly backend: SecretBackend;
  readonly exitCode: number;
  readonly excerpt: string;

  constructor(backend: SecretBackend, exitCode: number, excerpt: string) {
    super(`the ${backend.label} readiness answer was not understood (exit ${exitCode}): ${excerpt}`);
    this.name = 'SecretStoreAnswerError';
    this.backend = backend;
    this.exitCode = exitCode;
    this.excerpt = excerpt;
  }
}

const unfinishedText = (subject: string, limit: OperationLimitError): string => `${subject} did not finish within ${limit.label} of ${limit.limitMs} ms`;

const subjectOf = (call: SecretCall): string => (call.name === undefined ? `the ${call.action} of the key of the stored credentials` : `the ${call.action} of the secret "${call.name}"`);

const afterSemicolon = (part: string | undefined): string => (part === undefined ? '' : `; ${part}`);

const endedCallText = (call: SecretCall, limit: OperationLimitError, follow: string | undefined): string =>
  `${unfinishedText(subjectOf(call), limit)}${afterSemicolon(call.backend?.unansweredAdvice)}${afterSemicolon(follow)}`;

export class StoreCallEndedError extends Error {
  readonly call: SecretCall;
  readonly limit: OperationLimitError;

  constructor(call: SecretCall, limit: OperationLimitError, follow?: string) {
    super(endedCallText(call, limit, follow), { cause: limit });
    this.name = 'StoreCallEndedError';
    this.call = call;
    this.limit = limit;
  }
}

export const endedStoreCall = (call: SecretCall, reason: unknown): unknown => (reason instanceof OperationLimitError ? new StoreCallEndedError(call, reason) : reason);

export type LimitEnd = { call: SecretCall | undefined; limit: OperationLimitError };

const CAUSE_CHAIN_DEPTH = 8;

export const limitEndOf = (error: unknown): LimitEnd | undefined => {
  let current = error;
  for (let depth = 0; depth < CAUSE_CHAIN_DEPTH; depth += 1) {
    if (current instanceof StoreCallEndedError) return { call: current.call, limit: current.limit };
    if (current instanceof OperationLimitError) return { call: undefined, limit: current };
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
};

export const limitEndText = (end: LimitEnd, bareSubject: string): string =>
  end.call === undefined ? unfinishedText(bareSubject, end.limit) : endedCallText(end.call, end.limit, undefined);
