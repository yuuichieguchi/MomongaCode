import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, registerCleanup, startFakeSiwcAuth } from '@momonga/testkit';
import type { CleanupContext, SiwcAuth } from '@momonga/testkit';
import { createIdTokenVerifier } from '../src/plan/id-token.ts';
import type { IdTokenVerdict } from '../src/plan/id-token.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CONCURRENT = 4;

type PlanFetch = (url: string, init: RequestInit) => Promise<Response>;

type VerifierOptions = { jwksUrl: string; outbound: <T>(signal: AbortSignal, use: (fetch: PlanFetch) => Promise<T>) => Promise<T>; lifetime: AbortSignal; clock: ReturnType<typeof createFakeClock> };

const segment = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const tokenWithKid = (kid: string): string => `${segment({ alg: 'RS256', typ: 'JWT', kid })}.${segment({ iss: 'issuer' })}.${segment({ signature: 'none' })}`;

const verifierAt = async (context: CleanupContext): Promise<{ auth: SiwcAuth; verify: () => Promise<IdTokenVerdict> }> => {
  const auth = await startFakeSiwcAuth({});
  registerCleanup(context, () => auth.close());
  const options: VerifierOptions = {
    jwksUrl: auth.jwksUrl,
    outbound: (_signal, use) => use((url, init) => fetch(url, init)),
    lifetime: new AbortController().signal,
    clock: createFakeClock(Date.now()),
  };
  const verifier = createIdTokenVerifier(options as unknown as Parameters<typeof createIdTokenVerifier>[0]);
  const kid = auth.jwks().keys[0]?.kid ?? 'kid-missing';
  const expected = { issuer: 'issuer', clientId: 'client', nonce: 'nonce', algorithms: ['RS256'] };
  return { auth, verify: () => verifier(tokenWithKid(kid), expected) };
};

describe('O-R5-6 L2: the JWKS fetch is one flight shared by its waiters', () => {
  it('concurrent verifications share one key fetch', async (context) => {
    const { auth, verify } = await verifierAt(context);
    const verdicts = await Promise.all(Array.from({ length: CONCURRENT }, verify));
    expect(auth.calls.jwks).toBe(1);
    for (const verdict of verdicts) expect(verdict).not.toEqual({ kind: 'keys_unavailable' });
  });

  it('a failed fetch gives every waiter jwks_unavailable and caches nothing', async (context) => {
    const { auth, verify } = await verifierAt(context);
    auth.scriptJwks([{ kind: 'http', status: 500 }]);
    const verdicts = await Promise.all(Array.from({ length: CONCURRENT }, verify));
    expect(auth.calls.jwks).toBe(1);
    expect(verdicts).toEqual(Array.from({ length: CONCURRENT }, () => ({ kind: 'keys_unavailable' })));
  });

  it('the next verification starts a new fetch', async (context) => {
    const { auth, verify } = await verifierAt(context);
    auth.scriptJwks([{ kind: 'http', status: 500 }]);
    expect(await verify()).toEqual({ kind: 'keys_unavailable' });
    expect(auth.calls.jwks).toBe(1);
    expect(await verify()).not.toEqual({ kind: 'keys_unavailable' });
    expect(auth.calls.jwks).toBe(2);
  });
});
