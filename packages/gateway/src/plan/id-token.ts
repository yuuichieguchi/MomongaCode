import { isRecord, parseJwt, parseOutsideJson, verifyRs256 } from '@momonga/foundation';
import type { Clock, ParsedJwt } from '@momonga/foundation';
import type { IdTokenCheck } from '@momonga/protocol';
import { PLAN_SESSION_DEFAULTS, PLAN_SIGN_IN_DEFAULTS } from '../defaults.ts';
import { cappedSend } from './capped-send.ts';
import type { BoundedSendPorts } from './refresh.ts';

export type IdTokenExpectation = { issuer: string; clientId: string; nonce: string; algorithms: readonly string[] };

export type IdTokenVerdict = { kind: 'valid'; subject: string; email?: string } | { kind: 'invalid'; check: IdTokenCheck } | { kind: 'keys_unavailable' };

export type IdTokenVerifier = (idToken: string, expected: IdTokenExpectation) => Promise<IdTokenVerdict>;

type Jwk = Readonly<Record<string, unknown>>;

type KeySet = { keys: ReadonlyMap<string, Jwk>; fetchedAt: number };

class KeysUnavailable extends Error {}

const SECOND_MS = 1000;

const keysOf = (text: string): ReadonlyMap<string, Jwk> => {
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(text);
  } catch {
    throw new KeysUnavailable('the key set is not JSON');
  }
  const listed = isRecord(parsed) ? parsed['keys'] : undefined;
  if (!Array.isArray(listed) || listed.length > PLAN_SIGN_IN_DEFAULTS.keysMaxCount) throw new KeysUnavailable('the key set has no usable keys array');
  return new Map(listed.flatMap((key: unknown): Array<[string, Jwk]> => (isRecord(key) && typeof key['kid'] === 'string' ? [[key['kid'], key]] : [])));
};

const audienceHolds = (aud: unknown, clientId: string): boolean => (typeof aud === 'string' ? aud === clientId : Array.isArray(aud) && aud.includes(clientId));

const claimsCheck = (jwt: ParsedJwt, expected: IdTokenExpectation, nowMs: number): IdTokenVerdict => {
  const { claims } = jwt;
  if (claims['iss'] !== expected.issuer) return { kind: 'invalid', check: 'issuer' };
  if (!audienceHolds(claims['aud'], expected.clientId)) return { kind: 'invalid', check: 'audience' };
  const exp = claims['exp'];
  if (typeof exp !== 'number' || exp * SECOND_MS + PLAN_SESSION_DEFAULTS.skewMs <= nowMs) return { kind: 'invalid', check: 'expired' };
  if (claims['nonce'] !== expected.nonce) return { kind: 'invalid', check: 'nonce' };
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.trim() === '') return { kind: 'invalid', check: 'subject' };
  const email = claims['email'];
  return { kind: 'valid', subject: sub, ...(typeof email === 'string' && email !== '' ? { email } : {}) };
};

export const createIdTokenVerifier = (options: { jwksUrl: string; ports: BoundedSendPorts; clock: Clock }): IdTokenVerifier => {
  let cached: KeySet | undefined;

  const fetchKeys = async (): Promise<KeySet> => {
    const outcome = await cappedSend(options.ports, options.jwksUrl, { method: 'GET', headers: { accept: 'application/json' } }, PLAN_SIGN_IN_DEFAULTS.keysTimeoutMs, PLAN_SIGN_IN_DEFAULTS.keysBodyBytes);
    if (outcome.kind === 'unanswered' || outcome.status !== 200 || outcome.truncated) throw new KeysUnavailable('the key set could not be fetched');
    const fetched = { keys: keysOf(outcome.body), fetchedAt: options.clock.now() };
    cached = fetched;
    return fetched;
  };

  const keyFor = async (kid: string): Promise<Jwk | undefined> => {
    const current = cached ?? (await fetchKeys());
    const found = current.keys.get(kid);
    if (found !== undefined) return found;
    const elapsed = options.clock.now() - current.fetchedAt;
    if (elapsed >= 0 && elapsed < PLAN_SIGN_IN_DEFAULTS.keysRefetchMs) return undefined;
    return (await fetchKeys()).keys.get(kid);
  };

  return async (idToken, expected) => {
    let jwt: ParsedJwt;
    try {
      jwt = parseJwt(idToken);
    } catch {
      return { kind: 'invalid', check: 'signature' };
    }
    if (jwt.header['alg'] !== 'RS256' || !expected.algorithms.includes(jwt.header['alg'])) return { kind: 'invalid', check: 'algorithm' };
    const kid = jwt.header['kid'];
    if (typeof kid !== 'string') return { kind: 'invalid', check: 'signature' };
    let key: Jwk | undefined;
    try {
      key = await keyFor(kid);
    } catch (error) {
      if (error instanceof KeysUnavailable) return { kind: 'keys_unavailable' };
      throw error;
    }
    if (key === undefined || !verifyRs256(jwt, key)) return { kind: 'invalid', check: 'signature' };
    return claimsCheck(jwt, expected, options.clock.now());
  };
};
