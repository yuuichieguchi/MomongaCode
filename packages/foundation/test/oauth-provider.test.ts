import { describe, expect, it } from 'vitest';
import { OAuthAuthorizationError, createMemoryCredentialStore, createOAuthProvider } from '@momonga/foundation';
import type { OAuthProviderOptions } from '@momonga/foundation';

const KEY = 'mcp-oauth/server/abc';
const ISSUER = 'https://issuer.example.com';
const TOKENS = { access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'Bearer' };
const AUTHORIZE = 'https://auth.example.com/authorize?state=s';

const build = (overrides: Partial<OAuthProviderOptions> = {}) => {
  const store = createMemoryCredentialStore();
  const received: URL[] = [];
  const provider = createOAuthProvider({
    key: KEY,
    subject: 'the test client',
    store,
    redirectUrl: 'http://127.0.0.1:1/callback',
    randomToken: () => 'random-state',
    onAuthorizationUrl: (url) => {
      received.push(url);
    },
    ...overrides,
  });
  return { provider, store, received };
};

describe('oauth provider with every hook at its default', () => {
  it('hands the authorization URL on unchanged', async () => {
    const { provider, received } = build();
    await provider.redirectToAuthorization(new URL(AUTHORIZE));
    expect(received.map((url) => url.href)).toEqual([AUTHORIZE]);
  });

  it('implements no optional SDK method that would change how the SDK builds a token request', () => {
    const { provider } = build();
    for (const name of ['prepareTokenRequest', 'addClientAuthentication', 'dpop', 'scopeForRefresh', 'validateResourceURL']) {
      expect(name in provider).toBe(false);
    }
  });

  it('stores accepted tokens under the key and returns them', async () => {
    const { provider, store } = build();
    await provider.saveTokens(TOKENS, { issuer: ISSUER });
    expect(await provider.tokens({ issuer: ISSUER })).toEqual(TOKENS);
    expect(JSON.parse((await store.read(KEY)) as string)).toEqual({ version: 1, lastIssuer: ISSUER, issuers: { [ISSUER]: { tokens: TOKENS } } });
  });

  it('reports each secret it stores or returns', async () => {
    const seen: string[] = [];
    const { provider } = build({ onSecret: (value) => seen.push(value) });
    await provider.saveTokens(TOKENS, { issuer: ISSUER });
    expect(seen).toEqual(['fake-access', 'fake-refresh']);
    expect(await provider.secretValues()).toEqual(['fake-access', 'fake-refresh']);
  });

  it('draws the state from randomToken and exposes it', () => {
    const { provider } = build();
    expect(provider.expectedState).toBeUndefined();
    expect(provider.state?.()).toBe('random-state');
    expect(provider.expectedState).toBe('random-state');
  });

  it('removes everything for scope all and only the tokens for scope tokens', async () => {
    const { provider, store } = build();
    await provider.saveClientInformation?.({ client_id: 'c' }, { issuer: ISSUER });
    await provider.saveTokens(TOKENS, { issuer: ISSUER });
    await provider.invalidateCredentials?.('tokens');
    expect(await provider.tokens({ issuer: ISSUER })).toBeUndefined();
    expect((await provider.clientInformation({ issuer: ISSUER }))?.client_id).toBe('c');
    await provider.invalidateCredentials?.('all');
    expect(await store.read(KEY)).toBeUndefined();
  });

  it('refuses a stored record of an unrecognised shape', async () => {
    const { provider, store } = build();
    await store.write(KEY, JSON.stringify({ version: 2, issuers: {} }));
    await expect(provider.tokens({ issuer: ISSUER })).rejects.toThrow('stored credentials have an unrecognised shape');
  });
});

describe('oauth provider failures', () => {
  it('names its subject when authorization is required and there is no redirect target', async () => {
    const { provider } = build({ redirectUrl: undefined });
    const failure = await Promise.resolve()
      .then(() => provider.redirectToAuthorization(new URL(AUTHORIZE)))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OAuthAuthorizationError);
    expect((failure as OAuthAuthorizationError).failure).toBe('required');
    expect((failure as OAuthAuthorizationError).message).toBe('the test client requires authorization and has no valid credentials');
  });

  it('refuses a code verifier when no authorization is in progress', () => {
    const { provider } = build();
    expect(() => provider.codeVerifier()).toThrow(OAuthAuthorizationError);
    provider.saveCodeVerifier('verifier');
    expect(provider.codeVerifier()).toBe('verifier');
  });
});

describe('oauth provider hooks', () => {
  it('appends the extra authorization parameters before the URL is handed on', async () => {
    const seenByHook: string[] = [];
    const { provider, received } = build({
      authorizationParams: (url) => {
        seenByHook.push(url.href);
        return { nonce: 'n-1', login_hint: 'a@example.com' };
      },
    });
    await provider.redirectToAuthorization(new URL(AUTHORIZE));
    expect(seenByHook).toEqual([AUTHORIZE]);
    expect(received[0]?.searchParams.get('nonce')).toBe('n-1');
    expect(received[0]?.searchParams.get('login_hint')).toBe('a@example.com');
    expect(received[0]?.searchParams.get('state')).toBe('s');
  });

  it('refuses an extra parameter that the SDK already set', async () => {
    const { provider, received } = build({ authorizationParams: () => ({ state: 'other' }) });
    await expect(Promise.resolve().then(() => provider.redirectToAuthorization(new URL(AUTHORIZE)))).rejects.toThrow('authorization parameter "state" is already set');
    expect(received).toEqual([]);
  });

  it('stores nothing when acceptTokens vetoes by throwing, and stores when it returns', async () => {
    const seen: unknown[] = [];
    let veto = true;
    const { provider, store } = build({
      acceptTokens: (response) => {
        seen.push(response);
        if (veto) throw new Error('scope check failed');
      },
    });
    await expect(provider.saveTokens(TOKENS, { issuer: ISSUER })).rejects.toThrow('scope check failed');
    expect(await store.read(KEY)).toBeUndefined();
    veto = false;
    await provider.saveTokens(TOKENS, { issuer: ISSUER });
    expect(seen).toEqual([TOKENS, TOKENS]);
    expect(await provider.tokens({ issuer: ISSUER })).toEqual(TOKENS);
  });

  it('awaits an asynchronous acceptTokens before storing', async () => {
    const order: string[] = [];
    const { provider } = build({
      acceptTokens: async () => {
        await Promise.resolve();
        order.push('accepted');
      },
    });
    await provider.saveTokens(TOKENS, { issuer: ISSUER });
    order.push('saved');
    expect(order).toEqual(['accepted', 'saved']);
  });
});
