import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseJwt, verifyEs256 } from '@momonga/foundation';

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('verifyEs256', () => {
  it('verifies a valid P-256 IEEE-P1363 JWT and rejects forged or non-P-256 keys', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const otherJwk = other.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

    const signingInput = `${encode({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${encode({ sub: 'u1', iss: 'https://auth.x.ai' })}`;
    const signature = createSign('sha256').update(signingInput).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const jwt = parseJwt(`${signingInput}.${signature}`);

    expect(verifyEs256(jwt, jwk)).toBe(true);
    expect(verifyEs256(jwt, otherJwk)).toBe(false);
    expect(verifyEs256(jwt, { ...jwk, crv: 'P-384' })).toBe(false);
    expect(verifyEs256(jwt, { kty: 'RSA', n: 'abc', e: 'AQAB' })).toBe(false);
  });
});
