import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import type { BlobPort, IdempotencyPort } from '@momonga/tools';

const toPorts = (store: RuntimeStore): { idempotency: IdempotencyPort; blobs: BlobPort } => {
  const idempotency: IdempotencyPort = store.idempotency;
  const blobs: BlobPort = store.blobs;
  return { idempotency, blobs };
};

const lookupOf = (store: RuntimeStore, key: string): ReturnType<IdempotencyPort['get']> => {
  const port: IdempotencyPort = store.idempotency;
  return port.get(key);
};

describe('tools ports accept store objects', () => {
  it('assigns RuntimeStore idempotency and blobs to the tools ports', () => {
    expect(typeof toPorts).toBe('function');
    expect(typeof lookupOf).toBe('function');
  });
});
