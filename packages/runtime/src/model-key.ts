import { canonicalJson, sha256Hex } from '@momonga/foundation';

export const modelKey = (runId: string, step: number, attempt: number): string => sha256Hex(canonicalJson([runId, step, attempt]));
