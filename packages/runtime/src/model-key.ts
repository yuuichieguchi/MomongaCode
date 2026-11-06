import { canonicalJson, sha256Hex } from '@momonga/foundation';

export const modelKey = (runId: string, step: number, attempt: number): string => sha256Hex(canonicalJson([runId, step, attempt]));

export const requestKey = (runId: string, purpose: string, request: unknown): string => sha256Hex(canonicalJson([runId, purpose, sha256Hex(canonicalJson(request))]));
