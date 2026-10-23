import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

const UNKNOWN = 'b'.repeat(64);

describe('blobs.read of an unknown handle', () => {
  it('rejects a line range read with code BLOB_NOT_FOUND', async () => {
    const { store } = harness();
    await expect(store.blobs.read(UNKNOWN, { lineStart: 1, lineEnd: 1 })).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

  it('rejects a byte range read with code BLOB_NOT_FOUND', async () => {
    const { store } = harness();
    await expect(store.blobs.read(UNKNOWN, { offset: 0, length: 1 })).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

});
