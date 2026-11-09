import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { ensureHostIdentity, hostIdOf, jwkThumbprint, resetHostIdentity } from '../src/plan/host-identity.ts';
import { PROFILE_ID, planError, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const RFC7638_RSA_EXAMPLE = {
  kty: 'RSA',
  n:
    '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6' +
    '4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9' +
    '1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
  e: 'AQAB',
  alg: 'RS256',
  kid: '2011-04-29',
};

const directories: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const hostFile = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'momonga-plan-host-'));
  directories.push(directory);
  return path.join(directory, 'state', 'plan-host.json');
};

describe('the host ID is the RFC 9278 URN of the RFC 7638 thumbprint of an EC P-256 key (D7, F17)', () => {
  it('reproduces the RFC 7638 section 3.1 example thumbprint', () => {
    expect(jwkThumbprint(RFC7638_RSA_EXAMPLE)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('pins the URN string form', () => {
    expect(hostIdOf(RFC7638_RSA_EXAMPLE)).toBe('urn:ietf:params:oauth:jwk-thumbprint:sha-256:NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('an EC key thumbprint equals the SHA-256 of the canonical crv, kty, x, y object computed here', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
    const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expected = createHash('sha256').update(canonical, 'utf8').digest('base64url');
    expect(jwkThumbprint({ ...jwk, kid: 'ignored', use: 'sig' })).toBe(expected);
  });
});

describe('plan-host.json', () => {
  it('is created once with an EC P-256 key, mode 0600 in a 0700 directory, and read back unchanged', async () => {
    const file = await hostFile();
    const created = await ensureHostIdentity(nodeFileSystem, file, { accountsExist: false });
    expect(created.hostId).toMatch(/^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { hostId: string; privateKey: { kty: string; crv: string; d?: string } };
    expect(stored.hostId).toBe(created.hostId);
    expect(stored.privateKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(typeof stored.privateKey.d).toBe('string');
    expect(hostIdOf(stored.privateKey)).toBe(created.hostId);
    expect((await ensureHostIdentity(nodeFileSystem, file, { accountsExist: true })).hostId).toBe(created.hostId);
  });

  it('is never recreated silently: missing while an account record exists fails with a message naming the file', async () => {
    const file = await hostFile();
    await expect(ensureHostIdentity(nodeFileSystem, file, { accountsExist: true })).rejects.toThrow(file);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('an unreadable file fails with a message naming the file and is not replaced', async () => {
    const file = await hostFile();
    await ensureHostIdentity(nodeFileSystem, file, { accountsExist: false });
    await fs.chmod(file, 0o644);
    const before = await fs.readFile(file, 'utf8');
    await expect(ensureHostIdentity(nodeFileSystem, file, { accountsExist: true })).rejects.toThrow(file);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('only an explicit reset creates a new key, and the host ID changes', async () => {
    const file = await hostFile();
    const first = await ensureHostIdentity(nodeFileSystem, file, { accountsExist: false });
    const reset = await resetHostIdentity(nodeFileSystem, file);
    expect(reset.hostId).not.toBe(first.hostId);
    expect((await ensureHostIdentity(nodeFileSystem, file, { accountsExist: true })).hostId).toBe(reset.hostId);
  });

  it('is not created by opening the session engine', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await expect(fs.stat(h.paths.host)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a plan request fails with a message naming the file when it is missing while the account record exists', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await fs.rm(h.paths.host);
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    const failure = await planError(h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal));
    expect(failure.message).toContain(h.paths.host);
  });
});
