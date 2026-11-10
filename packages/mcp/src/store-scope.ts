import { AsyncLocalStorage } from 'node:async_hooks';
import { StoreCallEndedError } from '@momonga/foundation';
import type { CredentialStore, OperationLimit } from '@momonga/foundation';

export type StoreScope = { readonly signal: AbortSignal; live: boolean; endedStoreCall: StoreCallEndedError | undefined; pending: number };

type ScopeOwner = {
  scope: StoreScope;
  operationEnded(): void;
  callStarted(): void;
  callSettled(): void;
  callsSettled(): Promise<void>;
};

const scopes = new AsyncLocalStorage<StoreScope>();
const ownerOfSignal = new WeakMap<AbortSignal, ScopeOwner>();
const ownerOfScope = new WeakMap<StoreScope, ScopeOwner>();
const freshLimitOfSignal = new WeakMap<AbortSignal, OperationLimit>();

export const currentStoreScope = (): StoreScope | undefined => scopes.getStore();

export const createStoreScope = (operation: AbortSignal, lateLimit: () => OperationLimit): StoreScope => {
  const controller = new AbortController();
  const scope: StoreScope = { signal: controller.signal, live: true, endedStoreCall: undefined, pending: 0 };
  let late: OperationLimit | undefined;
  let whenNoCallIsPending: Array<() => void> = [];
  const endWithOperation = (): void => controller.abort(operation.reason);
  if (operation.aborted) endWithOperation();
  else operation.addEventListener('abort', endWithOperation, { once: true });
  const owner: ScopeOwner = {
    scope,
    operationEnded: () => {
      scope.live = false;
      operation.removeEventListener('abort', endWithOperation);
      if (scope.pending === 0 || controller.signal.aborted) return;
      const armed = lateLimit();
      late = armed;
      const endWithLateLimit = (): void => controller.abort(armed.signal.reason);
      if (armed.signal.aborted) endWithLateLimit();
      else armed.signal.addEventListener('abort', endWithLateLimit, { once: true });
    },
    callStarted: () => {
      scope.pending += 1;
    },
    callSettled: () => {
      scope.pending -= 1;
      if (scope.pending > 0) return;
      late?.dispose();
      const waiting = whenNoCallIsPending;
      whenNoCallIsPending = [];
      for (const resolve of waiting) resolve();
    },
    callsSettled: () => (scope.pending === 0 ? Promise.resolve() : new Promise<void>((resolve) => void whenNoCallIsPending.push(resolve))),
  };
  ownerOfSignal.set(controller.signal, owner);
  ownerOfScope.set(scope, owner);
  return scope;
};

export const runInStoreScope = async <T>(scope: StoreScope, task: () => Promise<T>): Promise<T> => {
  try {
    return await scopes.run(scope, task);
  } finally {
    ownerOfScope.get(scope)?.operationEnded();
  }
};

export const storeCallsSettled = (scope: StoreScope): Promise<void> => ownerOfScope.get(scope)?.callsSettled() ?? Promise.resolve();

export const storeCallSignal = (freshLimit: () => OperationLimit): AbortSignal => {
  const scope = currentStoreScope();
  if (scope !== undefined && scope.live && !scope.signal.aborted) return scope.signal;
  const limit = freshLimit();
  freshLimitOfSignal.set(limit.signal, limit);
  return limit.signal;
};

const underItsSignal = async <T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> => {
  const owner = ownerOfSignal.get(signal);
  owner?.callStarted();
  try {
    return await call();
  } catch (error) {
    if (owner !== undefined && error instanceof StoreCallEndedError) owner.scope.endedStoreCall ??= error;
    throw error;
  } finally {
    owner?.callSettled();
    freshLimitOfSignal.get(signal)?.dispose();
  }
};

export const storeUnderCallSignals = (store: CredentialStore): CredentialStore => ({
  read: (key, signal) => underItsSignal(signal, () => store.read(key, signal)),
  write: (key, value, signal) => underItsSignal(signal, () => store.write(key, value, signal)),
  update: (key, change, signal) => underItsSignal(signal, () => store.update(key, change, signal)),
  remove: (key, signal) => underItsSignal(signal, () => store.remove(key, signal)),
  withKey: (key, action, signal) => underItsSignal(signal, () => store.withKey(key, action, signal)),
});
