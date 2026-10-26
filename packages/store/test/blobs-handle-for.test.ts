import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

describe('blobs.handleFor', () => {
  it.for([
    ['ASCII text', 'plain text\nwith two lines'],
    ['multi-byte UTF-8', 'こんにちは 🌍 café'],
    ['the empty string', ''],
  ])('returns the handle that put returns for %s', ([, text]) => {
    const { store } = harness();

    const handle = store.blobs.handleFor(text as string);

    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect(store.blobs.put(text as string, { mediaType: 'text/plain' }).handle).toBe(handle);
  });
});
