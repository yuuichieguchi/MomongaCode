import type { OutboundNetwork } from '@momonga/foundation';

export const UNCONFIGURED_NETWORK: OutboundNetwork = { config: { caFiles: [] }, trust: { sources: [], failures: [] } };

export const hostTimers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout),
  timeoutSignal: (ms: number): AbortSignal => AbortSignal.timeout(ms),
};

export const UNDICI_DEFAULT_LIVENESS = { headersTimeoutMs: 300_000, idleTimeoutMs: 300_000, timers: hostTimers } as const;
