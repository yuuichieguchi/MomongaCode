import crypto from 'node:crypto';

export type ReviewCall = { runId: string; callId: string; basis: string };

const keyOf = (call: ReviewCall, seed: string): string => crypto.createHash('sha256').update(call.callId + seed).digest('hex');

export const reviewSample = (calls: readonly ReviewCall[], options: { size: number; seed: string }): ReviewCall[] =>
  calls
    .map((call) => ({ call, key: keyOf(call, options.seed) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, options.size)
    .map(({ call }) => call);
