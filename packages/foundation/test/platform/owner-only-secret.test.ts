import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { OWNER_ONLY_SECRET_BYTES, ownerOnlySecret } from '../../src/platform/owner-only-secret.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

const ports = () => ({ files: nodeFileSystem, random: systemRandom, lock: testKernelLock() });

const privateDirectory = (): string => {
  const directory = path.join(makeTemporaryDirectory(), 'run');
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
};

describe('C23: an owner-only random secret', () => {
  it('is created once as a 128-bit value in an owner-only file, and read back by every later call', async () => {
    const directory = privateDirectory();
    const first = await ownerOnlySecret(ports(), directory, 'endpoint.token');
    expect(first).toMatch(new RegExp(`^[0-9a-f]{${OWNER_ONLY_SECRET_BYTES * 2}}$`));
    expect(OWNER_ONLY_SECRET_BYTES).toBe(16);
    const file = path.join(directory, 'endpoint.token');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await ownerOnlySecret(ports(), directory, 'endpoint.token')).toBe(first);
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('gives two callers racing for the first value the same value', async () => {
    const directory = privateDirectory();
    const [left, right] = await Promise.all([ownerOnlySecret(ports(), directory, 'race.token'), ownerOnlySecret(ports(), directory, 'race.token')]);
    expect(left).toBe(right);
  });

  it('refuses a file another account could read', async () => {
    const directory = privateDirectory();
    const file = path.join(directory, 'open.token');
    fs.writeFileSync(file, 'a'.repeat(32), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await expect(ownerOnlySecret(ports(), directory, 'open.token')).rejects.toThrow(/0600/);
  });

  it('refuses a file that does not hold a 128-bit value, and never replaces it', async () => {
    const directory = privateDirectory();
    const file = path.join(directory, 'short.token');
    fs.writeFileSync(file, 'abc', { mode: 0o600 });
    await expect(ownerOnlySecret(ports(), directory, 'short.token')).rejects.toThrow(`${file} does not hold a 128-bit value`);
    expect(fs.readFileSync(file, 'utf8')).toBe('abc');
  });
});
