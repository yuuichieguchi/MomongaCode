import type { LoopbackRedirect, LoopbackRedirectOptions } from '@momonga/foundation';

type AuthorizationErrorClass = new (failure: 'timed_out', message: string) => Error;

type PendingListenerTimer = { id: number; delayMs: number; fire(): void };

const pending = new Map<number, PendingListenerTimer>();
let nextId = 1;
let failWaiting: ((error: unknown) => void) | undefined;

export const LISTENER_PORT_OF_SCRIPT = 49152;

export const listenerClock = {
  setTimeout: (fire: () => void, delayMs: number): number => {
    const id = nextId++;
    pending.set(id, { id, delayMs, fire });
    return id;
  },
  clearTimeout: (id: number): void => {
    pending.delete(id);
  },
  pendingDelays: (): number[] => [...pending.values()].map((timer) => timer.delayMs),
  fireAll: (): void => {
    for (const timer of [...pending.values()]) {
      pending.delete(timer.id);
      timer.fire();
    }
  },
};

export const failWaitingListener = (error: unknown): void => {
  if (failWaiting === undefined) throw new Error('no listener is waiting for a callback');
  failWaiting(error);
};

export const resetScriptedLoopback = (): void => {
  pending.clear();
  failWaiting = undefined;
};

export const scriptedLoopbackStart =
  (AuthorizationError: AuthorizationErrorClass) =>
  async ({ path }: LoopbackRedirectOptions): Promise<LoopbackRedirect> => ({
    redirectUrl: `http://127.0.0.1:${LISTENER_PORT_OF_SCRIPT}${path}`,
    callback: ({ signal, timeoutMs }) =>
      new Promise<URLSearchParams>((_resolve, reject) => {
        signal.throwIfAborted();
        const timer = listenerClock.setTimeout(() => finish(() => reject(new AuthorizationError('timed_out', 'authorization was not completed in the browser in time'))), timeoutMs);
        const onAbort = (): void => finish(() => reject(signal.reason));
        function finish(settle: () => void): void {
          listenerClock.clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          failWaiting = undefined;
          settle();
        }
        signal.addEventListener('abort', onAbort, { once: true });
        failWaiting = (error) => finish(() => reject(error));
      }),
    close: async () => undefined,
  });
