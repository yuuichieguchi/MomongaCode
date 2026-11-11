export type KeyReadLimit = { limitMs: number; label: string };

export const keyReadLimitOf = (headersTimeoutMs: number): KeyReadLimit => ({ limitMs: headersTimeoutMs, label: 'the request limit' });
