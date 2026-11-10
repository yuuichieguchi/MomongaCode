import { HOST_READ_BOUND_MS } from '@momonga/foundation';

export type KeyReadLimit = { limitMs: number; label: string };

export const keyReadLimitOf = (headersTimeoutMs: number): KeyReadLimit =>
  headersTimeoutMs > 0 ? { limitMs: headersTimeoutMs, label: 'the request limit' } : { limitMs: HOST_READ_BOUND_MS, label: 'the secret read limit' };
