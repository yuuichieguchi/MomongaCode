import type { SecretStore } from '@momonga/foundation';

export type SecretListener = (name: string, value: string) => void;

export type SecretResolver = {
  read(name: string, signal: AbortSignal): Promise<string>;
  resolved(): ReadonlyMap<string, string>;
  onResolved(listener: SecretListener): void;
};

type Inflight = { promise: Promise<string>; controller: AbortController; waiters: number };

export const createSecretResolver = (store: SecretStore): SecretResolver => {
  const values = new Map<string, string>();
  const inflight = new Map<string, Inflight>();
  const listeners: SecretListener[] = [];

  const start = (name: string): Inflight => {
    const controller = new AbortController();
    const entry: Inflight = {
      controller,
      waiters: 0,
      promise: (async () => {
        try {
          const value = await store.read(name, controller.signal);
          values.set(name, value);
          for (const listener of listeners) listener(name, value);
          return value;
        } finally {
          if (inflight.get(name)?.controller === controller) inflight.delete(name);
        }
      })(),
    };
    inflight.set(name, entry);
    return entry;
  };

  const join = (name: string, entry: Inflight, signal: AbortSignal): Promise<string> => {
    entry.waiters += 1;
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        entry.waiters -= 1;
        if (entry.waiters === 0) {
          if (inflight.get(name) === entry) inflight.delete(name);
          entry.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };

  return {
    read: async (name, signal) => {
      signal.throwIfAborted();
      const known = values.get(name);
      if (known !== undefined) return known;
      return join(name, inflight.get(name) ?? start(name), signal);
    },
    resolved: () => values,
    onResolved: (listener) => void listeners.push(listener),
  };
};
