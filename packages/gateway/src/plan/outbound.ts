import type { PlanFetch } from './refresh.ts';

export type PlanOutbound = <T>(signal: AbortSignal, use: (fetch: PlanFetch) => Promise<T>) => Promise<T>;

export type PlanScope = { fetch: PlanFetch; plaintextTokenFiles: boolean };
