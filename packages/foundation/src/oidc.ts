import { createPublicKey, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { isRecord } from './json.ts';
import { parseOutsideJson } from './json-depth.ts';

export type ParsedJwt = { header: Record<string, unknown>; claims: Record<string, unknown>; signingInput: string; signature: Buffer };

const JWT_PART = /^[A-Za-z0-9_-]*$/;

const decodedObject = (part: string, what: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = parseOutsideJson(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`the JWT ${what} is not base64url JSON`);
  }
  if (!isRecord(value)) throw new Error(`the JWT ${what} is not a JSON object`);
  return value;
};

export const parseJwt = (token: string): ParsedJwt => {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => JWT_PART.test(part))) throw new Error('the JWT does not have three base64url parts');
  const [header = '', claims = '', signature = ''] = parts;
  return { header: decodedObject(header, 'header'), claims: decodedObject(claims, 'claims'), signingInput: `${header}.${claims}`, signature: Buffer.from(signature, 'base64url') };
};

export const verifyRs256 = (jwt: ParsedJwt, jwk: Readonly<Record<string, unknown>>): boolean => {
  if (jwk['kty'] !== 'RSA' || typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') return false;
  const key = createPublicKey({ key: { kty: 'RSA', n: jwk['n'], e: jwk['e'] } satisfies JsonWebKey, format: 'jwk' });
  return verify('RSA-SHA256', Buffer.from(jwt.signingInput), key, jwt.signature);
};

export const verifyEs256 = (jwt: ParsedJwt, jwk: Readonly<Record<string, unknown>>): boolean => {
  if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256' || typeof jwk['x'] !== 'string' || typeof jwk['y'] !== 'string') return false;
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk['x'], y: jwk['y'] } satisfies JsonWebKey, format: 'jwk' });
  return verify('sha256', Buffer.from(jwt.signingInput), { key, dsaEncoding: 'ieee-p1363' }, jwt.signature);
};
