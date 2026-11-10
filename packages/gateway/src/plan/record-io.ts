import type { CredentialEntry, CredentialStore } from '@momonga/foundation';
import { PLAN_STORE_UNREADABLE_CODE, PLAN_STORE_UNWRITABLE_CODE } from '@momonga/protocol';
import { PlanCredentialError } from './auth-source.ts';

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const storeWriteFailure = (what: string, cause: unknown): PlanCredentialError =>
  new PlanCredentialError(PLAN_STORE_UNWRITABLE_CODE, `${what} could not be written: ${describeError(cause)}`, false, { cause });

export const storeReadFailure = (message: string, cause: unknown): PlanCredentialError => new PlanCredentialError(PLAN_STORE_UNREADABLE_CODE, message, false, { cause });

export const recordAccess = async <T>(kind: 'read' | 'write', what: string, action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PlanCredentialError) throw error;
    throw kind === 'read' ? storeReadFailure(`${what} cannot be read: ${describeError(error)}`, error) : storeWriteFailure(what, error);
  }
};

export const withRecord = async <T>(store: Pick<CredentialStore, 'withKey'>, key: string, what: string, action: (entry: CredentialEntry) => Promise<T>): Promise<T> => {
  let started = false;
  try {
    return await store.withKey(key, (entry) => {
      started = true;
      return action(entry);
    });
  } catch (error) {
    if (started) throw error;
    throw storeWriteFailure(what, error);
  }
};
