import { REQUEUE_BASE_MS, REQUEUE_MAX_MS, STORE_MAX_ATTEMPTS } from '../process/constants.ts';
import { RUNTIME_DEFAULTS } from '../process/defaults.ts';
import { SWEEP_INTERVAL_MS } from '../service/service.ts';

export const reflectionAttemptsBoundMs = (attemptTimeoutMs: number): number => STORE_MAX_ATTEMPTS * (attemptTimeoutMs + REQUEUE_MAX_MS);

export const REFLECTION_ATTEMPTS_BOUND_MS = reflectionAttemptsBoundMs(RUNTIME_DEFAULTS.runTimeoutMs);

export const REFLECTION_PICKUP_BOUND_MS = 2 * SWEEP_INTERVAL_MS;

export const REFLECTION_POLL_MS = REQUEUE_BASE_MS;
