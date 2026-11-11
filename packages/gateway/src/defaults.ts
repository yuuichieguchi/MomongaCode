import { AUTH_DOCUMENT_MAX_BYTES, AUTHORIZATION_WAIT_MS, DEFAULT_STOP_VALUES } from '@momonga/foundation';
import type { GatewayConfig } from './types.ts';

const MIB = 1024 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

export const GATEWAY_CONFIG_DEFAULTS = {
  retry: { maxAttempts: 3, totalWaitMs: 84_000, baseMs: 500, maxMs: 8000 },
  breaker: { failureThreshold: 2, openMs: 30_000 },
  limits: { maxBodyBytes: 32 * MIB, maxIdempotencyFrameBytes: 64 * MIB, readerStallMs: 30_000 },
  idempotency: { ttlMs: SEVEN_DAYS_MS },
  closeGraceMs: DEFAULT_STOP_VALUES.closeGraceMs,
  sseKeepAliveMs: 15_000,
  detachedMaxMs: THIRTY_MINUTES_MS,
  websocketConnectionMs: SIXTY_MINUTES_MS,
} as const satisfies Omit<GatewayConfig, 'models'>;

const PLAN_ACCESS_LIFETIME_MS = 3_600_000;
const PLAN_ATTEMPT_TIMEOUT_MS = 15_000;
const PLAN_REVOCATION_TIMEOUT_MS = 10_000;
const PLAN_SKEW_MS = 60_000;
const planRetry = GATEWAY_CONFIG_DEFAULTS.retry;
const PERSIST_ATTEMPTS_PER_ACCESS_LIFETIME = 4;
const PLAN_REFRESH_BUDGET_MS = planRetry.maxAttempts * PLAN_ATTEMPT_TIMEOUT_MS + (planRetry.maxAttempts - 1) * planRetry.maxMs;

export const PLAN_SESSION_DEFAULTS = {
  accessLifetimeMs: PLAN_ACCESS_LIFETIME_MS,
  attemptTimeoutMs: PLAN_ATTEMPT_TIMEOUT_MS,
  revocationTimeoutMs: PLAN_REVOCATION_TIMEOUT_MS,
  skewMs: PLAN_SKEW_MS,
  refreshBudgetMs: PLAN_REFRESH_BUDGET_MS,
  marginMs: PLAN_SKEW_MS + PLAN_REFRESH_BUDGET_MS,
  revocationBudgetMs: planRetry.maxAttempts * PLAN_REVOCATION_TIMEOUT_MS + planRetry.baseMs + 2 * planRetry.baseMs,
  persistRetryMs: GATEWAY_CONFIG_DEFAULTS.breaker.openMs,
  persistRetryMaxMs: PLAN_ACCESS_LIFETIME_MS / PERSIST_ATTEMPTS_PER_ACCESS_LIFETIME,
  replacedAccessTokensKept: 3,
} as const;

const KIB = 1024;

export const PLAN_SIGN_IN_DEFAULTS = {
  attemptTtlMs: AUTHORIZATION_WAIT_MS + PLAN_ATTEMPT_TIMEOUT_MS,
  exchangeTimeoutMs: PLAN_ATTEMPT_TIMEOUT_MS,
  keysTimeoutMs: PLAN_REVOCATION_TIMEOUT_MS,
  catalogTimeoutMs: PLAN_REVOCATION_TIMEOUT_MS,
  keysRefetchMs: 60_000,
  keysBodyBytes: 64 * KIB,
  keysMaxCount: 16,
  authBodyBytes: AUTH_DOCUMENT_MAX_BYTES,
  errorTextChars: 64,
  randomStateBytes: 16,
  verifierBytes: 32,
} as const;

export const UPSTREAM_LIVENESS_DEFAULTS = { headersTimeoutMs: 300_000, idleTimeoutMs: 300_000 } as const;
