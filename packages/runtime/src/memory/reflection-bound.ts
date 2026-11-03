import { REQUEUE_BASE_MS, REQUEUE_MAX_MS, STORE_MAX_ATTEMPTS } from '../process/constants.ts';
import { RUNTIME_DEFAULTS } from '../process/defaults.ts';

export const REFLECTION_SETTLE_BOUND_MS = STORE_MAX_ATTEMPTS * (RUNTIME_DEFAULTS.runTimeoutMs + REQUEUE_MAX_MS);

export const REFLECTION_POLL_MS = REQUEUE_BASE_MS;
