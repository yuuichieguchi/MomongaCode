import type { GatewayConfig } from './types.ts';

const MIB = 1024 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export const GATEWAY_CONFIG_DEFAULTS = {
  retry: { maxAttempts: 3, baseMs: 500, maxMs: 8000 },
  breaker: { failureThreshold: 5, openMs: 30_000 },
  limits: { maxBodyBytes: 32 * MIB, maxIdempotencyFrameBytes: 64 * MIB, idempotencyReaderStallMs: 30_000 },
  idempotency: { ttlMs: SEVEN_DAYS_MS },
  closeGraceMs: 10_000,
  sseKeepAliveMs: 15_000,
  detachedMaxMs: THIRTY_MINUTES_MS,
} as const satisfies Omit<GatewayConfig, 'models'>;

export const FM_PROVIDER_NAME = 'apple';
export const ANTHROPIC_PROVIDER_NAME = 'anthropic';
export const OPENAI_FORMAT_PROVIDER_NAME = 'openai';

export const FM_SERVE_DEFAULTS = {
  healthTimeoutMs: 10_000,
  restartBackoffMs: 1000,
  stopGraceMs: 3000,
  maxRestarts: 5,
  restartResetMs: 60_000,
  preconditionTtlMs: 60_000,
} as const;
