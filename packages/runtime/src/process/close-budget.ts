import { RUNTIME_ABORT_BUDGET_MS, RUNTIME_TEARDOWN_BUDGET_MS } from './constants.ts';

export const runtimeMaxCloseMs = (drainTimeoutMs: number): number => drainTimeoutMs + RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS;
