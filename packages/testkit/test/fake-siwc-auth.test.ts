import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SIWC_CALLBACK_PATH,
  SIWC_DYNAMIC_CLIENT_ID,
  SIWC_FULL_SCOPE,
  SIWC_RESOURCE,
  siwcBrowse,
  startFakeSiwcAuth,
} from '../src/index.ts';
import type { SiwcAuth } from '../src/index.ts';

const servers: SiwcAuth[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const start = async (options: Parameters<typeof startFakeSiwcAuth>[0] = {}): Promise<SiwcAuth> => {
  const server = await startFakeSiwcAuth(options);
  servers.push(server);
  return server;
};

const HOST = 'urn:ietf:params:oauth:jwk-thumbprint:sha-256:host-one';
const REDIRECT = `http://127.0.0.1:54321${SIWC_CALLBACK_PATH}`;

type Attempt = { verifier: string; state: string; nonce: string; url: string };

const attempt = (auth: SiwcAuth, params: Record<string, string>, redirectUri = REDIRECT): Attempt => {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const url = new URL(auth.authorizeUrl);
  const query: Record<string, string> = {
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SIWC_FULL_SCOPE,
    resource: SIWC_RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ext_agent_host_id: HOST,
    ...params,
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return { verifier, state, nonce, url: url.toString() };
};

const postForm = (url: string, form: Record<string, string>): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });

type Tokens = { access_token: string; refresh_token: string; id_token: string; token_type: string; expires_in: number; scope: string; earliest_refresh_at?: unknown };

type SignedIn = { clientId: string; tokens: Tokens; attempt: Attempt };

const signIn = async (auth: SiwcAuth, params: Record<string, string> = { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'MomongaCode' }): Promise<SignedIn> => {
  const started = attempt(auth, params);
  const browsed = await siwcBrowse(started.url);
  const callback = browsed.redirect;
  if (callback === undefined) throw new Error(`no redirect: ${JSON.stringify(browsed.body)}`);
  const clientId = callback.searchParams.get('client_id') ?? params['client_id'] ?? '';
  const response = await postForm(auth.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: callback.searchParams.get('code') ?? '',
    code_verifier: started.verifier,
    redirect_uri: REDIRECT,
    resource: SIWC_RESOURCE,
  });
  if (response.status !== 200) throw new Error(`exchange ${response.status}: ${await response.text()}`);
  return { clientId, tokens: (await response.json()) as Tokens, attempt: started };
};

const refresh = (auth: SiwcAuth, clientId: string, refreshToken: string): Promise<Response> =>
  postForm(auth.tokenUrl, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: SIWC_RESOURCE });

const segments = (jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; signature: Buffer } => {
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>,
    signed: `${header}.${claims}`,
    signature: Buffer.from(signature, 'base64url'),
  };
};

const signatureHolds = async (auth: SiwcAuth, jwt: string): Promise<boolean> => {
  const { header, signed, signature } = segments(jwt);
  const document = (await (await fetch(auth.jwksUrl)).json()) as { keys: Array<Record<string, unknown> & { kid: string }> };
  const jwk = document.keys.find((key) => key.kid === header['kid']);
  if (jwk === undefined) return false;
  return verify('RSA-SHA256', Buffer.from(signed), createPublicKey({ key: jwk as never, format: 'jwk' }), signature);
};

describe('fake Sign in with ChatGPT authorization server: discovery and registration', () => {
  it('serves a discovery document whose endpoints are on its own origin at the paths of the evidence', async () => {
    const auth = await start();
    const document = (await (await fetch(auth.discoveryUrl)).json()) as Record<string, unknown>;
    expect(document['issuer']).toBe(auth.issuer);
    expect(document['authorization_endpoint']).toBe(`${auth.issuer}/api/accounts/authorize`);
    expect(document['token_endpoint']).toBe(`${auth.issuer}/api/accounts/oauth/token`);
    expect(document['revocation_endpoint']).toBe(`${auth.issuer}/api/accounts/oauth/revoke`);
    expect(document['jwks_uri']).toBe(`${auth.issuer}/.well-known/jwks.json`);
    expect(document['code_challenge_methods_supported']).toEqual(['S256']);
    expect(document['id_token_signing_alg_values_supported']).toEqual(['RS256']);
    expect(auth.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('registers a new client from dynamic_agent_client with a host id and a name, and returns the issued id in the callback', async () => {
    const auth = await start();
    const started = attempt(auth, { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'MomongaCode' });
    const { status, redirect } = await siwcBrowse(started.url);
    expect(status).toBe(302);
    expect(`${redirect?.origin}${redirect?.pathname}`).toBe(`http://127.0.0.1:54321${SIWC_CALLBACK_PATH}`);
    expect(redirect?.searchParams.get('state')).toBe(started.state);
    expect(redirect?.searchParams.get('client_id')).toMatch(/^oaiapp_/);
    expect(redirect?.searchParams.get('code')).not.toBeNull();
    expect(redirect?.searchParams.get('scope')).toBe(SIWC_FULL_SCOPE);
    expect(auth.registrations()).toEqual([{ clientId: redirect?.searchParams.get('client_id'), hostId: HOST, agentName: 'MomongaCode', sub: auth.identity.sub }]);
  });

  it.each([
    ['a localhost redirect', { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm' }, 'http://localhost:54321/auth/callback'],
    ['a redirect path of /callback', { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm' }, 'http://127.0.0.1:54321/callback'],
    ['an https redirect', { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm' }, 'https://127.0.0.1:54321/auth/callback'],
  ])('refuses %s', async (_name, params, redirectUri) => {
    const auth = await start();
    const { status, redirect } = await siwcBrowse(attempt(auth, params, redirectUri).url);
    expect(status).toBe(400);
    expect(redirect).toBeUndefined();
  });

  it.each([
    ['a missing host id', { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm', ext_agent_host_id: '' }],
    ['a registration without an agent name', { client_id: SIWC_DYNAMIC_CLIENT_ID }],
    ['an unknown issued client', { client_id: 'oaiapp_unknown' }],
    ['a missing nonce', { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm', nonce: '' }],
    ['a plain challenge method', { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm', code_challenge_method: 'plain' }],
    ['a foreign resource', { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm', resource: 'https://example.invalid/v1' }],
  ])('refuses %s', async (_name, params) => {
    const auth = await start();
    const started = attempt(auth, params);
    const url = new URL(started.url);
    for (const [key, value] of [...url.searchParams.entries()]) if (value === '') url.searchParams.delete(key);
    expect((await siwcBrowse(url.toString())).status).toBe(400);
  });

  it('refuses a returning sign-in that repeats the agent name, or that comes from another host', async () => {
    const auth = await start();
    const first = await signIn(auth);
    expect((await siwcBrowse(attempt(auth, { client_id: first.clientId, agent_name_hint: 'MomongaCode' }).url)).status).toBe(400);
    expect((await siwcBrowse(attempt(auth, { client_id: first.clientId, ext_agent_host_id: 'urn:uuid:other' }).url)).status).toBe(400);
    expect((await siwcBrowse(attempt(auth, { client_id: first.clientId }).url)).status).toBe(302);
  });

  it('accepts the hints of a returning sign-in and records them with every query', async () => {
    const auth = await start();
    const first = await signIn(auth);
    await siwcBrowse(attempt(auth, { client_id: first.clientId, id_token_hint: first.tokens.id_token, login_hint: 'user@example.com' }).url);
    const last = auth.records.at(-1);
    expect(last?.path).toBe('/api/accounts/authorize');
    expect(last?.form['id_token_hint']).toBe(first.tokens.id_token);
    expect(last?.form['login_hint']).toBe('user@example.com');
    expect(auth.calls.authorize).toBe(2);
  });

  it('gives a returning sign-in the callback without a client id when the mode omits it, and a registration none either', async () => {
    const auth = await start();
    const first = await signIn(auth);
    auth.authorizeMode = 'omit_client_id';
    const returning = await siwcBrowse(attempt(auth, { client_id: first.clientId }).url);
    expect(returning.redirect?.searchParams.has('client_id')).toBe(false);
    const registration = await siwcBrowse(attempt(auth, { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'MomongaCode' }).url);
    expect(registration.redirect?.searchParams.has('client_id')).toBe(false);
    expect(registration.redirect?.searchParams.has('code')).toBe(true);
  });
});

describe('fake Sign in with ChatGPT authorization server: the browser', () => {
  it('plays access_denied with the state', async () => {
    const auth = await start();
    auth.authorizeMode = 'access_denied';
    const started = attempt(auth, { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm' });
    const { redirect } = await siwcBrowse(started.url);
    expect(redirect?.searchParams.get('error')).toBe('access_denied');
    expect(redirect?.searchParams.get('state')).toBe(started.state);
    expect(redirect?.searchParams.has('code')).toBe(false);
  });

  it('plays a callback with a wrong state', async () => {
    const auth = await start();
    auth.authorizeMode = 'wrong_state';
    const started = attempt(auth, { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm' });
    const { redirect } = await siwcBrowse(started.url);
    expect(redirect?.searchParams.get('state')).not.toBe(started.state);
    expect(redirect?.searchParams.has('code')).toBe(true);
  });

  it('plays a callback that carries a client id other than the one of the account', async () => {
    const auth = await start();
    const first = await signIn(auth);
    auth.authorizeMode = 'foreign_client_id';
    const { redirect } = await siwcBrowse(attempt(auth, { client_id: first.clientId }).url);
    const presented = redirect?.searchParams.get('client_id');
    expect(presented).toMatch(/^oaiapp_/);
    expect(presented).not.toBe(first.clientId);
  });

  it('plays a replayed code: the code of the previous authorization, already exchanged', async () => {
    const auth = await start();
    const first = await signIn(auth);
    auth.authorizeMode = 'replayed_code';
    const started = attempt(auth, { client_id: first.clientId });
    const { redirect } = await siwcBrowse(started.url);
    const response = await postForm(auth.tokenUrl, {
      grant_type: 'authorization_code',
      client_id: first.clientId,
      code: redirect?.searchParams.get('code') ?? '',
      code_verifier: started.verifier,
      redirect_uri: REDIRECT,
      resource: SIWC_RESOURCE,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('withholds the scopes it is told to withhold from the callback and from the token response', async () => {
    const auth = await start();
    auth.withheldScopes = ['chatgpt.tokens.use.direct'];
    const signedIn = await signIn(auth);
    expect(signedIn.tokens.scope.split(' ')).not.toContain('chatgpt.tokens.use.direct');
    expect(signedIn.tokens.scope.split(' ')).toContain('offline_access');
    expect(segments(signedIn.tokens.access_token).claims['scope']).toBe(signedIn.tokens.scope);
  });
});

describe('fake Sign in with ChatGPT authorization server: the code exchange', () => {
  it('sends earliest_refresh_at as a number, a string, null or not at all, as asked', async () => {
    expect(typeof (await signIn(await start({ earliestRefreshAtForm: 'number' }))).tokens.earliest_refresh_at).toBe('number');
    expect(typeof (await signIn(await start({ earliestRefreshAtForm: 'string' }))).tokens.earliest_refresh_at).toBe('string');
    expect((await signIn(await start({ earliestRefreshAtForm: 'null' }))).tokens.earliest_refresh_at).toBeNull();
    expect('earliest_refresh_at' in (await signIn(await start({ earliestRefreshAtForm: 'absent' }))).tokens).toBe(false);
  });

  it('returns the seven fields of the token reference, with an access token that carries the documented claims', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    expect(Object.keys(tokens).sort()).toEqual(['access_token', 'earliest_refresh_at', 'expires_in', 'id_token', 'refresh_token', 'scope', 'token_type']);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(typeof tokens.earliest_refresh_at).toBe('number');
    const { claims } = segments(tokens.access_token);
    expect(claims['aud']).toBe(SIWC_RESOURCE);
    expect(claims['client_id']).toBe(clientId);
    expect(claims['iss']).toBe(auth.issuer);
    expect(claims['sub']).toBe(auth.identity.sub);
    expect(claims['scope']).toBe(SIWC_FULL_SCOPE);
    for (const name of ['iat', 'exp', 'nbf', 'jti']) expect(claims).toHaveProperty(name);
  });

  it('signs an ID token with RS256 for the issued client, the nonce of the attempt and the identity', async () => {
    const auth = await start();
    const { clientId, tokens, attempt: started } = await signIn(auth);
    const { header, claims } = segments(tokens.id_token);
    expect(header['alg']).toBe('RS256');
    expect(claims['iss']).toBe(auth.issuer);
    expect(claims['aud']).toBe(clientId);
    expect(claims['nonce']).toBe(started.nonce);
    expect(claims['sub']).toBe(auth.identity.sub);
    expect(claims['email']).toBe(auth.identity.email);
    expect(claims['exp']).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await signatureHolds(auth, tokens.id_token)).toBe(true);
  });

  it('consumes a code once and checks the verifier, the redirect uri, the resource and the client', async () => {
    const auth = await start();
    const started = attempt(auth, { client_id: SIWC_DYNAMIC_CLIENT_ID, agent_name_hint: 'm' });
    const code = (await siwcBrowse(started.url)).redirect?.searchParams.get('code') ?? '';
    const clientId = auth.registrations()[0]?.clientId ?? '';
    const base = { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: started.verifier, redirect_uri: REDIRECT, resource: SIWC_RESOURCE };
    for (const wrong of [{ code_verifier: 'x'.repeat(43) }, { redirect_uri: 'http://127.0.0.1:1/auth/callback' }, { resource: 'https://example.invalid/v1' }, { client_id: 'oaiapp_other' }]) {
      const rejected = await postForm(auth.tokenUrl, { ...base, ...wrong });
      expect(rejected.status, JSON.stringify(wrong)).toBe(400);
      expect(((await rejected.json()) as { error: string }).error).toBe('invalid_grant');
    }
    expect((await postForm(auth.tokenUrl, base)).status).toBe(400);
    const fresh = attempt(auth, { client_id: clientId });
    const freshCode = (await siwcBrowse(fresh.url)).redirect?.searchParams.get('code') ?? '';
    const accepted = await postForm(auth.tokenUrl, { ...base, code: freshCode, code_verifier: fresh.verifier });
    expect(accepted.status).toBe(200);
    expect((await postForm(auth.tokenUrl, { ...base, code: freshCode, code_verifier: fresh.verifier })).status).toBe(400);
  });

  it('counts calls and records the form bodies of the endpoints', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    await refresh(auth, clientId, tokens.refresh_token);
    expect(auth.calls).toMatchObject({ authorize: 1, tokenAuthorizationCode: 1, tokenRefreshToken: 1, revoke: 0 });
    const exchange = auth.records.find((record) => record.form['grant_type'] === 'authorization_code');
    expect(exchange?.path).toBe('/api/accounts/oauth/token');
    expect(exchange?.form['client_id']).toBe(clientId);
    const renewal = auth.records.at(-1);
    expect(renewal?.form).toEqual({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: SIWC_RESOURCE });
  });
});

describe('fake Sign in with ChatGPT authorization server: refresh', () => {
  it('rotates a single-use refresh token and issues access tokens that verify', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    const renewed = (await (await refresh(auth, clientId, tokens.refresh_token)).json()) as Tokens;
    expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
    expect(renewed.access_token).not.toBe(tokens.access_token);
    expect(renewed.scope).toBe(tokens.scope);
    expect(auth.verifyAccessToken(renewed.access_token, SIWC_RESOURCE)).toBe('valid');
    expect(auth.verifyAccessToken(renewed.access_token, 'https://example.invalid/v1')).toBe('unknown');
    expect(auth.verifyAccessToken(undefined, SIWC_RESOURCE)).toBe('unknown');
  });

  it('answers a reuse with refresh_token_reused and revokes the whole family when family revocation is on', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    const renewed = (await (await refresh(auth, clientId, tokens.refresh_token)).json()) as Tokens;
    const reuse = await refresh(auth, clientId, tokens.refresh_token);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('refresh_token_reused');
    expect(((await (await refresh(auth, clientId, renewed.refresh_token)).json()) as { error: string }).error).toBe('refresh_token_invalidated');
    expect(auth.verifyAccessToken(renewed.access_token, SIWC_RESOURCE)).toBe('revoked');
  });

  it('answers a reuse with refresh_token_reused and keeps the successor alive when family revocation is off', async () => {
    const auth = await start();
    auth.familyRevocationOnReuse = false;
    const { clientId, tokens } = await signIn(auth);
    const renewed = (await (await refresh(auth, clientId, tokens.refresh_token)).json()) as Tokens;
    expect(((await (await refresh(auth, clientId, tokens.refresh_token)).json()) as { error: string }).error).toBe('refresh_token_reused');
    expect((await refresh(auth, clientId, renewed.refresh_token)).status).toBe(200);
  });

  it('answers invalid_grant for an unknown token and for another client, and checks the resource', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    expect(((await (await refresh(auth, clientId, 'unknown')).json()) as { error: string }).error).toBe('invalid_grant');
    expect(((await (await refresh(auth, 'oaiapp_other', tokens.refresh_token)).json()) as { error: string }).error).toBe('invalid_grant');
    const wrongResource = await postForm(auth.tokenUrl, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: 'https://example.invalid/v1' });
    expect(wrongResource.status).toBe(400);
  });

  it.each([
    ['invalid_grant', 400],
    ['invalid_refresh_token', 400],
    ['token_expired', 400],
    ['refresh_token_expired', 400],
    ['refresh_token_invalidated', 400],
    ['refresh_token_reused', 400],
    ['invalid_client', 401],
  ])('plays the scripted refresh error %s with status %i without rotating', async (code, status) => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    auth.scriptToken('refresh_token', [{ kind: 'error', code }]);
    const played = await refresh(auth, clientId, tokens.refresh_token);
    expect(played.status).toBe(status);
    expect(((await played.json()) as { error: string }).error).toBe(code);
    expect((await refresh(auth, clientId, tokens.refresh_token)).status).toBe(200);
  });

  it('expires refresh tokens with refresh_token_expired and honours a disconnect with refresh_token_invalidated', async () => {
    const auth = await start();
    const first = await signIn(auth);
    auth.expireRefreshTokens();
    expect(((await (await refresh(auth, first.clientId, first.tokens.refresh_token)).json()) as { error: string }).error).toBe('refresh_token_expired');
    const second = await signIn(auth);
    auth.disconnect(second.clientId);
    expect(((await (await refresh(auth, second.clientId, second.tokens.refresh_token)).json()) as { error: string }).error).toBe('refresh_token_invalidated');
    expect(auth.verifyAccessToken(second.tokens.access_token, SIWC_RESOURCE)).toBe('revoked');
  });

  it('plays a transient 503 with a Retry-After, a body that is not JSON, and a connection dropped before the rotation', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    auth.scriptToken('refresh_token', [
      { kind: 'http', status: 503, headers: { 'retry-after': '3' } },
      { kind: 'http', status: 200, body: 'not json' },
      { kind: 'drop' },
    ]);
    const unavailable = await refresh(auth, clientId, tokens.refresh_token);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('3');
    const garbage = await refresh(auth, clientId, tokens.refresh_token);
    expect(await garbage.text()).toBe('not json');
    await expect(refresh(auth, clientId, tokens.refresh_token)).rejects.toThrow();
    expect((await refresh(auth, clientId, tokens.refresh_token)).status).toBe(200);
    expect(auth.calls.tokenRefreshToken).toBe(4);
  });

  it('loses the response after the rotation: the token is consumed and the client never sees the replacement', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    auth.scriptToken('refresh_token', [{ kind: 'lose_response' }]);
    await expect(refresh(auth, clientId, tokens.refresh_token)).rejects.toThrow();
    expect(((await (await refresh(auth, clientId, tokens.refresh_token)).json()) as { error: string }).error).toBe('refresh_token_reused');
  });

  it('plays an answer without a replacement refresh token and one with a short lifetime', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    auth.scriptToken('refresh_token', [{ kind: 'no_replacement_refresh_token' }, { kind: 'expires_in', seconds: 60 }]);
    const missing = (await (await refresh(auth, clientId, tokens.refresh_token)).json()) as Record<string, unknown>;
    expect(missing).not.toHaveProperty('refresh_token');
    expect(missing['access_token']).toEqual(expect.any(String));
    const secondFirst = await signIn(auth);
    const short = (await (await refresh(auth, secondFirst.clientId, secondFirst.tokens.refresh_token)).json()) as Tokens;
    expect(short.expires_in).toBe(60);
  });

  it('expires access tokens by the injected clock and by the switch', async () => {
    let now = Date.parse('2026-11-06T00:00:00Z');
    const auth = await start({ now: () => now });
    const { tokens } = await signIn(auth);
    expect(auth.verifyAccessToken(tokens.access_token, SIWC_RESOURCE)).toBe('valid');
    now += 3_599_000;
    expect(auth.verifyAccessToken(tokens.access_token, SIWC_RESOURCE)).toBe('valid');
    now += 2_000;
    expect(auth.verifyAccessToken(tokens.access_token, SIWC_RESOURCE)).toBe('expired');
    const other = await signIn(auth);
    auth.expireAccessTokens();
    expect(auth.verifyAccessToken(other.tokens.access_token, SIWC_RESOURCE)).toBe('expired');
  });
});

describe('fake Sign in with ChatGPT authorization server: revocation', () => {
  const revoke = (auth: SiwcAuth, clientId: string, token: string): Promise<Response> =>
    postForm(auth.revokeUrl, { token, token_type_hint: 'refresh_token', client_id: clientId });

  it('answers an empty 200 for a live token and for an unknown one, and kills the token it names', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    const unknown = await revoke(auth, clientId, 'unknown');
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe('');
    const live = await revoke(auth, clientId, tokens.refresh_token);
    expect(live.status).toBe(200);
    expect(await live.text()).toBe('');
    expect(((await (await refresh(auth, clientId, tokens.refresh_token)).json()) as { error: string }).error).toBe('invalid_grant');
    expect(auth.calls.revoke).toBe(2);
    expect(auth.records.findLast((record) => record.path === '/api/accounts/oauth/revoke')?.form).toEqual({ token: tokens.refresh_token, token_type_hint: 'refresh_token', client_id: clientId });
  });

  it('revokes only the superseded token it names unless the family switch is on', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    const renewed = (await (await refresh(auth, clientId, tokens.refresh_token)).json()) as Tokens;
    await revoke(auth, clientId, tokens.refresh_token);
    expect((await refresh(auth, clientId, renewed.refresh_token)).status).toBe(200);

    auth.revokeSupersededFamily = true;
    const second = await signIn(auth);
    const secondRenewed = (await (await refresh(auth, second.clientId, second.tokens.refresh_token)).json()) as Tokens;
    await revoke(auth, second.clientId, second.tokens.refresh_token);
    expect((await refresh(auth, second.clientId, secondRenewed.refresh_token)).status).toBe(400);
  });

  it('plays a 5xx and a dropped connection, then answers normally', async () => {
    const auth = await start();
    const { clientId, tokens } = await signIn(auth);
    auth.scriptRevoke([{ kind: 'http', status: 503 }, { kind: 'drop' }]);
    expect((await revoke(auth, clientId, tokens.refresh_token)).status).toBe(503);
    await expect(revoke(auth, clientId, tokens.refresh_token)).rejects.toThrow();
    expect((await revoke(auth, clientId, tokens.refresh_token)).status).toBe(200);
    expect(auth.calls.revoke).toBe(3);
  });
});

describe('fake Sign in with ChatGPT authorization server: keys and ID-token flaws', () => {
  it('publishes RS256 keys by kid and rotates them, keeping or retiring the old key', async () => {
    const auth = await start();
    const first = await signIn(auth);
    const oldKid = segments(first.tokens.id_token).header['kid'];
    const kid = await auth.rotateKeys({ retireOld: false });
    expect(kid).not.toBe(oldKid);
    expect(auth.jwks().keys.map((key) => key.kid)).toEqual([oldKid, kid]);
    const second = await signIn(auth);
    expect(segments(second.tokens.id_token).header['kid']).toBe(kid);
    expect(await signatureHolds(auth, second.tokens.id_token)).toBe(true);
    await auth.rotateKeys({ retireOld: true });
    expect(auth.jwks().keys).toHaveLength(1);
    expect(await signatureHolds(auth, first.tokens.id_token)).toBe(false);
    expect(auth.calls.jwks).toBeGreaterThanOrEqual(2);
    for (const key of auth.jwks().keys) {
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      expect(key).not.toHaveProperty('d');
    }
  });

  it.each([
    ['forged_signature', async (auth: SiwcAuth, jwt: string) => expect(await signatureHolds(auth, jwt)).toBe(false)],
    ['unknown_kid', async (auth: SiwcAuth, jwt: string) => expect(auth.jwks().keys.map((key) => key.kid)).not.toContain(segments(jwt).header['kid'])],
    ['alg_none', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).header['alg']).toBe('none')],
    ['wrong_alg', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).header['alg']).toBe('HS256')],
    ['wrong_issuer', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).claims['iss']).not.toBe(_auth.issuer)],
    ['wrong_audience', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).claims['aud']).toBe('oaiapp_not_this_client')],
    ['expired', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).claims['exp']).toBeLessThan(Math.floor(Date.now() / 1000))],
    ['wrong_nonce', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).claims['nonce']).toBe('not-the-nonce-of-the-attempt')],
    ['missing_sub', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).claims).not.toHaveProperty('sub')],
    ['blank_sub', async (_auth: SiwcAuth, jwt: string) => expect(segments(jwt).claims['sub']).toBe('')],
  ] as const)('issues an ID token with the flaw %s', async (flaw, check) => {
    const auth = await start();
    auth.idTokenFlaw = flaw;
    const { tokens } = await signIn(auth);
    await check(auth, tokens.id_token);
  });

  it('lets a returning sign-in answer with another subject than the registration when told to', async () => {
    const auth = await start();
    const first = await signIn(auth);
    auth.subjectOverride = 'sub-of-someone-else';
    const second = await signIn(auth, { client_id: first.clientId });
    expect(segments(second.tokens.id_token).claims['sub']).toBe('sub-of-someone-else');
  });

  it('binds a new registration to the identity current when it registers', async () => {
    const auth = await start();
    auth.identity = { sub: 'sub-a', email: 'a@example.com' };
    const a = await signIn(auth);
    auth.identity = { sub: 'sub-b', email: 'b@example.com' };
    const b = await signIn(auth);
    expect(a.clientId).not.toBe(b.clientId);
    expect(segments(a.tokens.id_token).claims['sub']).toBe('sub-a');
    expect(segments(b.tokens.id_token).claims['sub']).toBe('sub-b');
    const again = await signIn(auth, { client_id: a.clientId });
    expect(segments(again.tokens.id_token).claims['sub']).toBe('sub-a');
  });
});

describe('fake Sign in with ChatGPT authorization server: canary tokens', () => {
  it('lists every secret it issued, each long, random and distinct, for leak searches', async () => {
    const auth = await start();
    const first = await signIn(auth);
    const renewed = (await (await refresh(auth, first.clientId, first.tokens.refresh_token)).json()) as Tokens;
    const secrets = auth.issuedSecrets();
    for (const token of [first.tokens.access_token, first.tokens.refresh_token, first.tokens.id_token, renewed.access_token, renewed.refresh_token, renewed.id_token]) {
      if (token !== undefined) expect(secrets).toContain(token);
    }
    expect(new Set(secrets).size).toBe(secrets.length);
    for (const secret of secrets) expect(secret.length).toBeGreaterThanOrEqual(64);
  });
});
