import type { ServiceTimers } from './timers.ts';

export type MemorySweeperOptions = {
  timers: ServiceTimers;
  intervalMs: number;
  upkeep(signal: AbortSignal): Promise<unknown>;
  reflect(signal: AbortSignal): Promise<unknown>;
  onError: (error: unknown) => void;
};

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

export const startMemorySweeper = ({ timers, intervalMs, upkeep, reflect, onError }: MemorySweeperOptions): { close(): Promise<void> } => {
  const closing = new AbortController();
  let handle: unknown;
  let inFlight: Promise<void> = Promise.resolve();

  const arm = (): void => {
    handle = timers.setTimeout(() => {
      inFlight = tick();
    }, intervalMs);
  };

  const tick = async (): Promise<void> => {
    for (const work of [upkeep, reflect]) {
      try {
        await work(closing.signal);
      } catch (error) {
        if (!(closing.signal.aborted && isAbort(error))) onError(error);
      }
    }
    if (!closing.signal.aborted) arm();
  };

  arm();
  return {
    close: async () => {
      closing.abort();
      timers.clearTimeout(handle);
      await inFlight;
    },
  };
};
