import { describe, expect, it } from 'vitest';
import { OAuthAuthorizationError, createMemoryCredentialStore, createOAuthProvider } from '@momonga/foundation';
import type { CredentialStore, OAuthProviderOptions } from '@momonga/foundation';

const KEY = 'mcp-oauth/server/abc';
const ISSUER = 'https://issuer.example.com';
const TOKENS = { access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'Bearer' };
const AUTHORIZE = 'https://auth.example.com/authorize?state=s';
const SIGNAL = new AbortController().signal;

const build = (overrides: Partial<OAuthProviderOptions> = {}) => {
  const store = overrides.store ?? createMemoryCredentialStore();
  const received: URL[] = [];
  const provider = createOAuthProvider({
    key: KEY,
    subject: 'the test client',
    store,
    signalForCall: () => SIGNAL,
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
    expect(JSON.parse((await store.read(KEY, SIGNAL)) as string)).toEqual({ version: 1, lastIssuer: ISSUER, issuers: { [ISSUER]: { tokens: TOKENS } } });
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
    await provider.saveClientInformation?.({ client_id: 'c', redirect_uris: ['http://127.0.0.1:1/callback'] }, { issuer: ISSUER });
    await provider.saveTokens(TOKENS, { issuer: ISSUER });
    await provider.invalidateCredentials?.('tokens');
    expect(await provider.tokens({ issuer: ISSUER })).toBeUndefined();
    expect((await provider.clientInformation({ issuer: ISSUER }))?.client_id).toBe('c');
    await provider.invalidateCredentials?.('all');
    expect(await store.read(KEY, SIGNAL)).toBeUndefined();
  });

  it('refuses a stored record of an unrecognised shape', async () => {
    const { provider, store } = build();
    await store.write(KEY, JSON.stringify({ version: 2, issuers: {} }), SIGNAL);
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
    expect(await store.read(KEY, SIGNAL)).toBeUndefined();
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

describe('oauth provider store calls under the signal of the operation', () => {
  const recordingStore = (): { store: CredentialStore; seen: Array<AbortSignal | undefined> } => {
    const inner = createMemoryCredentialStore();
    const seen: Array<AbortSignal | undefined> = [];
    const store: CredentialStore = {
      read: (key, signal) => {
        seen.push(signal);
        return inner.read(key, signal);
      },
      write: (key, value, signal) => {
        seen.push(signal);
        return inner.write(key, value, signal);
      },
      update: (key, change, signal) => {
        seen.push(signal);
        return inner.update(key, change, signal);
      },
      remove: (key, signal) => {
        seen.push(signal);
        return inner.remove(key, signal);
      },
      withKey: (key, action, signal) => {
        seen.push(signal);
        return inner.withKey(key, action, signal);
      },
    };
    return { store, seen };
  };

  type Provider = ReturnType<typeof build>['provider'];

  const STORE_CALLS: ReadonlyArray<readonly [string, (provider: Provider) => Promise<unknown>]> = [
    ['tokens', (provider) => Promise.resolve(provider.tokens({ issuer: ISSUER }))],
    ['saveTokens', (provider) => Promise.resolve(provider.saveTokens(TOKENS, { issuer: ISSUER }))],
    ['clientInformation', (provider) => Promise.resolve(provider.clientInformation({ issuer: ISSUER }))],
    ['saveClientInformation', (provider) => Promise.resolve(provider.saveClientInformation?.({ client_id: 'c' }, { issuer: ISSUER }))],
    ["invalidateCredentials('all')", (provider) => Promise.resolve(provider.invalidateCredentials?.('all'))],
    ["invalidateCredentials('tokens')", (provider) => Promise.resolve(provider.invalidateCredentials?.('tokens'))],
    ["invalidateCredentials('client')", (provider) => Promise.resolve(provider.invalidateCredentials?.('client'))],
    ['secretValues', (provider) => provider.secretValues()],
  ];

  it.for(STORE_CALLS)('every store call takes the signal supplied at that moment (%s)', async ([, call]) => {
    const { store, seen } = recordingStore();
    const atBuild = new AbortController().signal;
    let current = atBuild;
    const { provider } = build({ store, signalForCall: () => current });
    const atCall = new AbortController().signal;
    current = atCall;
    await call(provider);
    expect(seen.length).toBeGreaterThan(0);
    for (const signal of seen) expect(signal).toBe(atCall);
  });

  it('every store call takes the signal supplied at that moment (a second call after the supplier changes)', async () => {
    const { store, seen } = recordingStore();
    const first = new AbortController().signal;
    const second = new AbortController().signal;
    let current = first;
    const supplied: AbortSignal[] = [];
    const { provider } = build({
      store,
      signalForCall: () => {
        supplied.push(current);
        return current;
      },
    });
    await provider.tokens({ issuer: ISSUER });
    current = second;
    await provider.tokens({ issuer: ISSUER });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(first);
    expect(seen[1]).toBe(second);
    expect(supplied).toEqual([first, second]);
  });

  it('the calls that touch no store ask for no signal', () => {
    let asked = 0;
    const { provider } = build({
      signalForCall: () => {
        asked += 1;
        return SIGNAL;
      },
    });
    provider.state?.();
    provider.saveCodeVerifier('verifier');
    provider.codeVerifier();
    void provider.invalidateCredentials?.('verifier');
    void provider.invalidateCredentials?.('discovery');
    expect(asked).toBe(0);
  });
});

describe('C22: a stored client registration is reused only for the same redirect', () => {
  const PORT_A = 'http://127.0.0.1:41001/callback';
  const PORT_B = 'http://127.0.0.1:41002/callback';
  const registeredFor = (redirect: string) => ({ client_id: `client-for-${redirect}`, redirect_uris: [redirect] });

  it('asks for a new registration when the stored one was made for another redirect, and keeps the new one', async () => {
    const first = build({ redirectUrl: PORT_A });
    await first.provider.saveClientInformation?.(registeredFor(PORT_A), { issuer: ISSUER });
    const second = build({ redirectUrl: PORT_B, store: first.store });
    expect(await second.provider.clientInformation({ issuer: ISSUER })).toBeUndefined();
    await second.provider.saveClientInformation?.(registeredFor(PORT_B), { issuer: ISSUER });
    expect(await second.provider.clientInformation({ issuer: ISSUER })).toEqual(registeredFor(PORT_B));
    expect(JSON.parse((await first.store.read(KEY, SIGNAL)) as string).issuers[ISSUER].clientInformation).toEqual(registeredFor(PORT_B));
  });

  it('reuses the stored registration when its redirect URIs hold the current redirect', async () => {
    const { provider } = build({ redirectUrl: PORT_A });
    await provider.saveClientInformation?.(registeredFor(PORT_A), { issuer: ISSUER });
    expect(await provider.clientInformation({ issuer: ISSUER })).toEqual(registeredFor(PORT_A));
  });

  it('asks for a new registration when the stored one names no redirect URIs', async () => {
    const { provider } = build({ redirectUrl: PORT_A });
    await provider.saveClientInformation?.({ client_id: 'client-without-redirects' }, { issuer: ISSUER });
    expect(await provider.clientInformation({ issuer: ISSUER })).toBeUndefined();
  });

  it('keeps using the stored registration where no sign-in can start, to refresh with it', async () => {
    const first = build({ redirectUrl: PORT_A });
    await first.provider.saveClientInformation?.(registeredFor(PORT_A), { issuer: ISSUER });
    const passive = build({ redirectUrl: undefined, store: first.store });
    expect(await passive.provider.clientInformation({ issuer: ISSUER })).toEqual(registeredFor(PORT_A));
  });
});
