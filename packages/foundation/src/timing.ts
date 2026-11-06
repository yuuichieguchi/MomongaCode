export interface Timing {
  now(): number;
  monotonicMs(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SleepOutcome = 'slept' | 'aborted';

export const sleep = (timing: Pick<Timing, 'setTimeout' | 'clearTimeout'>, ms: number, signal?: AbortSignal): Promise<SleepOutcome> => {
  if (signal?.aborted === true) return Promise.resolve('aborted');
  return new Promise<SleepOutcome>((resolve) => {
    const onAbort = (): void => {
      timing.clearTimeout(handle);
      resolve('aborted');
    };
    const handle = timing.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};
