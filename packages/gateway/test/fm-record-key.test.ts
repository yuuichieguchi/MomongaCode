import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBinaryHashCache } from '@momonga/foundation';
import { makeDir } from './gateway-helpers.ts';

const asking = (): AbortSignal => new AbortController().signal;

describe('the binary hash of a managed server binary (design-managed-servers section 6.2)', () => {
  it('hashes the bytes of a readable file', async () => {
    const file = path.join(makeDir(), 'fm');
    fs.writeFileSync(file, 'binary');
    expect(await createBinaryHashCache().sha256Of(file, asking())).toBe(createHash('sha256').update('binary').digest('hex'));
  });

  it('fails when the file is missing, never answering with an empty hash', async () => {
    await expect(createBinaryHashCache().sha256Of(path.join(makeDir(), 'missing'), asking())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails when the file is not readable, never answering with an empty hash', async () => {
    const file = path.join(makeDir(), 'fm');
    fs.writeFileSync(file, 'binary', { mode: 0o111 });
    await expect(createBinaryHashCache().sha256Of(file, asking())).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('sees a replaced binary through its file identity', async () => {
    const file = path.join(makeDir(), 'fm');
    fs.writeFileSync(file, 'binary');
    const cache = createBinaryHashCache();
    await cache.sha256Of(file, asking());
    fs.writeFileSync(file, 'replaced binary');
    expect(await cache.sha256Of(file, asking())).toBe(createHash('sha256').update('replaced binary').digest('hex'));
  });
});
