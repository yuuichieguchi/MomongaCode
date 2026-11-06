import crypto from 'node:crypto';
import type { RunCallView } from '@momonga/protocol';

export type ReviewCall = RunCallView;

export type ReviewSample = { allowedWithoutPerson: ReviewCall[]; asks: ReviewCall[] };

const keyOf = (call: ReviewCall, seed: string): string => crypto.createHash('sha256').update(call.callId + seed).digest('hex');

const drawn = (calls: readonly ReviewCall[], options: { size: number; seed: string }): ReviewCall[] =>
  calls
    .map((call) => ({ call, key: keyOf(call, options.seed) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, options.size)
    .map(({ call }) => call);

const allowedWithoutPerson = (call: ReviewCall): boolean => !call.asked && call.basis !== null && call.basis !== 'person' && call.sideEffect !== 'read_only';

export const reviewSample = (calls: readonly ReviewCall[], options: { size: number; seed: string }): ReviewSample => ({
  allowedWithoutPerson: drawn(calls.filter(allowedWithoutPerson), options),
  asks: drawn(calls.filter((call) => call.asked), options),
});
