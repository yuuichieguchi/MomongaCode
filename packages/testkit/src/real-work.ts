import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { onTestFinished } from 'vitest';
import { waitFor } from './wait-for.ts';

const ONE_SHOT_REQUEST_TYPE_LIST = [
  'FSREQCALLBACK',
  'FSREQPROMISE',
  'FILEHANDLECLOSEREQ',
  'GETADDRINFOREQWRAP',
  'GETNAMEINFOREQWRAP',
  'QUERYWRAP',
  'TCPCONNECTWRAP',
  'PIPECONNECTWRAP',
  'WRITEWRAP',
  'SHUTDOWNWRAP',
  'Immediate',
] as const;

type OneShotRequestType = (typeof ONE_SHOT_REQUEST_TYPE_LIST)[number];

const ONE_SHOT_REQUEST_TYPES: ReadonlySet<string> = new Set<OneShotRequestType>(ONE_SHOT_REQUEST_TYPE_LIST);

export type RealWorkScope = {
  run<T>(fn: () => T): T;
  inFlight(): boolean;
  describe(): string;
  dispose(): void;
};

export const createRealWorkScope = (): RealWorkScope => {
  const storage = new AsyncLocalStorage<object>();
  const token = {};
  const requests = new Map<number, string>();
  const timers = new Map<number, { hasRef(): boolean }>();
  const hook = createHook({
    init: (asyncId, type, _trigger, resource) => {
      if (storage.getStore() !== token) return;
      if (ONE_SHOT_REQUEST_TYPES.has(type)) requests.set(asyncId, type);
      else if (type === 'Timeout' && 'hasRef' in resource && typeof resource.hasRef === 'function') timers.set(asyncId, resource as { hasRef(): boolean });
    },
    destroy: (asyncId) => {
      requests.delete(asyncId);
      timers.delete(asyncId);
    },
  }).enable();
  const refTimerCount = (): number => [...timers.values()].filter((timer) => timer.hasRef()).length;
  const scope: RealWorkScope = {
    run: (fn) => storage.run(token, fn),
    inFlight: () => requests.size > 0 || refTimerCount() > 0,
    describe: () => {
      const counts = new Map<string, number>();
      for (const type of requests.values()) counts.set(type, (counts.get(type) ?? 0) + 1);
      const requestSummary = [...counts].map(([type, count]) => `${type}=${String(count)}`).join(',');
      return `real work in flight: requests[${requestSummary}] refTimers=${String(refTimerCount())}`;
    },
    dispose: () => {
      hook.disable();
      requests.clear();
      timers.clear();
    },
  };
  onTestFinished(() => {
    scope.dispose();
  });
  return scope;
};

export const waitForRealWork = async (realWork: RealWorkScope, predicate: () => boolean, description: string): Promise<void> => {
  try {
    await waitFor(predicate, { description });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${realWork.describe()}`, { cause: error });
  }
};

const macrotask = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export const settleRealWork = async (realWork: RealWorkScope, done: () => boolean, description: string): Promise<void> => {
  await macrotask();
  await waitForRealWork(realWork, () => done() || !realWork.inFlight(), `${description} or quiet real work`);
};

export const quiesce = (realWork: RealWorkScope): Promise<void> => settleRealWork(realWork, () => false, 'quiet real work');
