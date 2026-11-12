import { systemTiming } from '@momonga/foundation';

export type ServiceTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  monotonicMs(): number;
};

export const systemTimers: ServiceTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  monotonicMs: () => systemTiming.monotonicMs(),
};
