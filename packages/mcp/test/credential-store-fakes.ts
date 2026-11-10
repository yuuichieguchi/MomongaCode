import { CredentialStoreError, createMemoryCredentialStore, endedStoreCall } from '@momonga/foundation';
import { KEYCHAIN_BACKEND } from '@momonga/foundation/secret-store';
import type { McpCredentialStore } from '@momonga/mcp';
import { vi } from 'vitest';

export const KEYCHAIN_UNANSWERED_ADVICE = 'the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain';

export const NO_DEFAULT_KEYCHAIN_REASON = 'security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)';

export const NO_STORE_REFUSAL = `No secret store was found on this host (${NO_DEFAULT_KEYCHAIN_REASON}). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.`;

export const keyReadLimitSentence = (label: string, limitMs: number): string =>
  `the read of the key of the stored credentials did not finish within ${label} of ${limitMs} ms; ${KEYCHAIN_UNANSWERED_ADVICE}`;

export type StoreMode = 'answer' | 'hang' | 'absent';

export type StoreCallRecord = { operation: 'read' | 'withKey'; key: string; signal: AbortSignal; mode: StoreMode; observed: unknown; rejection: unknown };

export type ControlledCredentialStore = {
  store: McpCredentialStore;
  calls: StoreCallRecord[];
  mode: StoreMode | (() => StoreMode);
  beforeAnswer: (() => Promise<void>) | undefined;
  observe: (() => unknown) | undefined;
  arrived(count: number, mode?: StoreMode): Promise<void>;
};

const abortOf = (signal: AbortSignal): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    if (signal.aborted) resolve(signal.reason);
    else signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
  });

export const controlledCredentialStore = (): ControlledCredentialStore => {
  const inner = createMemoryCredentialStore();
  const waiters: Array<{ count: number; mode: StoreMode | undefined; resolve(): void }> = [];
  const countOf = (mode: StoreMode | undefined): number => controlled.calls.filter((call) => mode === undefined || call.mode === mode).length;
  const gate = async (operation: StoreCallRecord['operation'], key: string, signal: AbortSignal): Promise<void> => {
    const mode = typeof controlled.mode === 'function' ? controlled.mode() : controlled.mode;
    const record: StoreCallRecord = { operation, key, signal, mode, observed: controlled.observe?.(), rejection: undefined };
    controlled.calls.push(record);
    for (const waiter of waiters.splice(0)) {
      if (countOf(waiter.mode) >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
    try {
      if (mode === 'absent') throw new CredentialStoreError('store_unreadable', NO_STORE_REFUSAL);
      if (mode === 'hang') throw endedStoreCall({ action: 'read', name: undefined, backend: KEYCHAIN_BACKEND }, await abortOf(signal));
      await controlled.beforeAnswer?.();
    } catch (error) {
      record.rejection = error;
      throw error;
    }
  };
  const controlled: ControlledCredentialStore = {
    calls: [],
    mode: 'answer',
    beforeAnswer: undefined,
    observe: undefined,
    store: {
      read: async (key, signal) => {
        await gate('read', key, signal);
        return inner.read(key, signal);
      },
      write: async (key, value, signal) => {
        await gate('withKey', key, signal);
        return inner.write(key, value, signal);
      },
      update: async (key, change, signal) => {
        await gate('withKey', key, signal);
        return inner.update(key, change, signal);
      },
      remove: async (key, signal) => {
        await gate('withKey', key, signal);
        return inner.remove(key, signal);
      },
      withKey: async (key, action, signal) => {
        await gate('withKey', key, signal);
        return inner.withKey(key, action, signal);
      },
    },
    arrived: (count, mode) =>
      new Promise<void>((resolve) => {
        if (countOf(mode) >= count) resolve();
        else waiters.push({ count, mode, resolve });
      }),
  };
  return controlled;
};

export type Outcome<T> = { state(): 'pending' | 'fulfilled' | 'rejected'; value(): T | undefined; error(): unknown };

export const outcomeOf = <T>(pending: Promise<T>): Outcome<T> => {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let value: T | undefined;
  let error: unknown;
  pending.then(
    (settled) => {
      state = 'fulfilled';
      value = settled;
    },
    (failure: unknown) => {
      state = 'rejected';
      error = failure;
    },
  );
  return { state: () => state, value: () => value, error: () => error };
};

export const afterPendingIo = (): Promise<void> => new Promise<void>((resolve) => void setImmediate(resolve));

export const useLimitTimers = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

const SETTLE_WAIT = { timeout: 2_000 };

export const LIMIT_TEST = { timeout: 20_000 };

export const settledAfter = async <T>(outcome: Outcome<T>): Promise<Outcome<T>> => {
  await vi.waitFor(() => {
    if (outcome.state() === 'pending') throw new Error('the operation has not settled');
  }, SETTLE_WAIT);
  return outcome;
};

export const stillPendingAfter = async (outcome: Outcome<unknown>, ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await afterPendingIo();
  if (outcome.state() !== 'pending') throw new Error(`the operation settled ${outcome.state()} before its limit: ${String(outcome.error() ?? outcome.value())}`);
};
