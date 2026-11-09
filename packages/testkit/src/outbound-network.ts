import type { OutboundNetwork } from '@momonga/foundation';

export const UNCONFIGURED_NETWORK: OutboundNetwork = { config: { caFiles: [] }, trust: { sources: [], failures: [] } };

export const UNDICI_DEFAULT_LIVENESS = { headersTimeoutMs: 300_000, idleTimeoutMs: 300_000 } as const;
