import { createHmac } from 'node:crypto';
import { canonicalJson } from '@momonga/foundation';
import { FENCE_BOUNDARY_LENGTH } from '@momonga/protocol';
import type { AdapterInputItem } from '@momonga/protocol';

const FENCE_DOMAIN = 'fence-boundary';

export type FenceBoundary = (input: readonly AdapterInputItem[]) => string;

export const createFenceBoundary =
  (key: Uint8Array): FenceBoundary =>
  (input) =>
    createHmac('sha256', key).update(`${FENCE_DOMAIN}\u0000${canonicalJson(input[0] ?? null)}`).digest('hex').slice(0, FENCE_BOUNDARY_LENGTH);
