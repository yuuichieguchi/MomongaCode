import { LockWaitTimeoutError, isTransientErrno, limitEndOf } from '@momonga/foundation';
import type { CredentialEntry, CredentialStore } from '@momonga/foundation';
import { PLAN_STORE_UNREADABLE_CODE, PLAN_STORE_UNWRITABLE_CODE } from '@momonga/protocol';
import { describeError } from '../core/describe-error.ts';
import { PlanCredentialError } from './auth-source.ts';

export const isTransientStoreFailure = (cause: unknown): boolean => cause instanceof LockWaitTimeoutError || isTransientErrno(cause);

export const storeWriteFailure = (what: string, cause: unknown): PlanCredentialError =>
  new PlanCredentialError(PLAN_STORE_UNWRITABLE_CODE, `${what} could not be written: ${describeError(cause)}`, cause instanceof LockWaitTimeoutError, { cause });

export const storeReadFailure = (message: string, cause: unknown): PlanCredentialError => new PlanCredentialError(PLAN_STORE_UNREADABLE_CODE, message, false, { cause });

export const endedByOperation = (error: unknown, signal: AbortSignal): boolean => (signal.aborted && error === signal.reason) || limitEndOf(error) !== undefined;

export const recordAccess = async <T>(kind: 'read' | 'write', what: string, action: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PlanCredentialError || endedByOperation(error, signal)) throw error;
    throw kind === 'read' ? storeReadFailure(`${what} cannot be read: ${describeError(error)}`, error) : storeWriteFailure(what, error);
  }
};

export const refusedEntry = (failure: PlanCredentialError, readFailure: unknown = failure): CredentialEntry => ({
  read: () => Promise.reject(readFailure),
  write: () => Promise.reject(failure),
  remove: () => Promise.reject(failure),
});

export type RecordLockRefusal = PlanCredentialError | undefined;

export const withRecord = async <T>(
  store: Pick<CredentialStore, 'withKey'>,
  key: string,
  what: string,
  action: (entry: CredentialEntry, refusal: RecordLockRefusal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  let started = false;
  try {
    return await store.withKey(
      key,
      (entry) => {
        started = true;
        return action(entry, undefined);
      },
      signal,
    );
  } catch (error) {
    if (started || endedByOperation(error, signal)) throw error;
    const refusal = storeWriteFailure(what, error);
    return action(refusedEntry(refusal), refusal);
  }
};
