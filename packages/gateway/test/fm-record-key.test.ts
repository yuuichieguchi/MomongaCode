import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256OfFile } from '../src/managed/fm-record-key.ts';
import { makeDir } from './gateway-helpers.ts';

describe('sha256OfFile', () => {
  it('hashes a readable file', async () => {
    const file = path.join(makeDir(), 'fm');
    fs.writeFileSync(file, 'binary');
    expect(await sha256OfFile(file)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails when the file is missing, never answering with an empty hash', async () => {
    await expect(sha256OfFile(path.join(makeDir(), 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails when the file is not readable, never answering with an empty hash', async () => {
    const file = path.join(makeDir(), 'fm');
    fs.writeFileSync(file, 'binary', { mode: 0o111 });
    await expect(sha256OfFile(file)).rejects.toMatchObject({ code: 'EACCES' });
  });
});
