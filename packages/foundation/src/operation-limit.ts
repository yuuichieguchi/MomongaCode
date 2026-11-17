import { systemTiming } from './system-timing.ts';
import type { Timing } from './timing.ts';

const SHORTEST_LIMIT_MS = 1;
export const LONGEST_LIMIT_MS = 2_147_483_647;

export class OperationLimitError extends Error {
  readonly limitMs: number;
  readonly label: string;

  constructor(limitMs: number, label: string) {
    super(`${label} of ${limitMs} ms passed`);
    this.name = 'OperationLimitError';
    this.limitMs = limitMs;
    this.label = label;
  }
}

export type LimitTiming = Pick<Timing, 'setTimeout' | 'clearTimeout'>;

export type OperationLimit = { readonly signal: AbortSignal; dispose(): void };

export const operationLimit = (parent: AbortSignal, limitMs: number, label: string, timing: LimitTiming = systemTiming): OperationLimit => {
  if (!Number.isInteger(limitMs) || limitMs < SHORTEST_LIMIT_MS || limitMs > LONGEST_LIMIT_MS) {
    throw new RangeError(`${label} must be an integer from ${SHORTEST_LIMIT_MS} to ${LONGEST_LIMIT_MS} ms, got ${limitMs}`);
  }
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const endWithParent = (): void => {
    timing.clearTimeout(timer);
    controller.abort(parent.reason);
  };
  const timer = timing.setTimeout(() => {
    parent.removeEventListener('abort', endWithParent);
    controller.abort(new OperationLimitError(limitMs, label));
  }, limitMs);
  parent.addEventListener('abort', endWithParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      timing.clearTimeout(timer);
      parent.removeEventListener('abort', endWithParent);
    },
  };
};

const ignored = (): void => undefined;

export const settledOrAborted = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      pending.then(ignored, ignored);
      reject(signal.reason);
      return;
    }
    const leave = (): void => reject(signal.reason);
    signal.addEventListener('abort', leave, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', leave);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(error);
      },
    );
  });
