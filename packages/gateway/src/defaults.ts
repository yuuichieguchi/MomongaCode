import type { GatewayConfig } from './types.ts';

const MIB = 1024 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

export const GATEWAY_CONFIG_DEFAULTS = {
  retry: { maxAttempts: 3, totalWaitMs: 84_000, baseMs: 500, maxMs: 8000 },
  breaker: { failureThreshold: 5, openMs: 30_000 },
  limits: { maxBodyBytes: 32 * MIB, maxIdempotencyFrameBytes: 64 * MIB, readerStallMs: 30_000 },
  idempotency: { ttlMs: SEVEN_DAYS_MS },
  closeGraceMs: 10_000,
  sseKeepAliveMs: 15_000,
  detachedMaxMs: THIRTY_MINUTES_MS,
  websocketConnectionMs: SIXTY_MINUTES_MS,
} as const satisfies Omit<GatewayConfig, 'models'>;

export const UPSTREAM_LIVENESS_DEFAULTS = { headersTimeoutMs: 600_000, bodyTimeoutMs: 600_000 } as const;

export const FM_PROVIDER_NAME = 'apple';
export const ANTHROPIC_PROVIDER_NAME = 'anthropic';
export const OLLAMA_PROVIDER_NAME = 'ollama';

export const FM_SERVE_DEFAULTS = {
  healthTimeoutMs: 10_000,
  restartBackoffMs: 1000,
  stopGraceMs: 3000,
  maxRestarts: 5,
  restartResetMs: 60_000,
  preconditionTtlMs: 60_000,
} as const;
