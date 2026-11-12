import { createHmac } from 'node:crypto';
import { canonicalJson } from '@momonga/foundation';
import type { AdapterInputItem } from '@momonga/protocol';

const FENCE_DOMAIN = 'fence-boundary';

const BOUNDARY_LENGTH = 32;

export type FenceBoundary = (input: readonly AdapterInputItem[]) => string;

export const createFenceBoundary =
  (key: Uint8Array): FenceBoundary =>
  (input) =>
    createHmac('sha256', key).update(`${FENCE_DOMAIN}\u0000${canonicalJson(input[0] ?? null)}`).digest('hex').slice(0, BOUNDARY_LENGTH);
