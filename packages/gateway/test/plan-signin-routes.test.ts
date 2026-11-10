import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import { ACCOUNT, CALLBACK_PORT, accountRoute, begin, browse, holdNextExchange, sessionsDirectory, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const failureOf = (answer: { status: number; body: any }) => ({ status: answer.status, type: answer.body.error?.type, code: answer.body.error?.code, message: answer.body.error?.message });

const withState = (callback: URL, state: string): string => {
  const changed = new URL(callback.toString());
  changed.searchParams.set('state', state);
  return changed.toString();
};

const callbackWith = (begun: { body: any }, params: Record<string, string>): string => {
  const url = new URL(`http://127.0.0.1:${CALLBACK_PORT}/auth/callback`);
  url.searchParams.set('state', begun.body.state);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
};

const complete = (gateway: PlanGateway, attemptId: string, callbackUrl: string) => gateway.post(PLAN_ROUTES.signInComplete, { attemptId, callbackUrl });

describe('sign-in begin builds the authorization URL from the profile (P5b, 5.1, 5.2)', () => {
  it('asks for a new registration with PKCE S256, state, nonce, the full scope set and the host id', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    expect(begun.status).toBe(200);
    const url = new URL(begun.body.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(gateway.profile.oauth.authorizeUrl);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'MomongaCode',
      response_type: 'code',
      redirect_uri: `http://127.0.0.1:${CALLBACK_PORT}/auth/callback`,
      resource: gateway.profile.oauth.resource,
      code_challenge_method: 'S256',
      state: begun.body.state,
    });
    expect(params['scope']?.split(' ').sort()).toEqual([...gateway.profile.oauth.identityScopes, ...gateway.profile.oauth.useScopes].sort());
    expect(params['nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(params['state']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(params['code_challenge']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params['ext_agent_host_id']).toMatch(/^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/);
    expect(params).not.toHaveProperty('prompt');
    expect(params).not.toHaveProperty('id_token_hint');
    expect(params).not.toHaveProperty('force_reconsent');
    expect(fs.existsSync(momongaLayout(gateway.home).planHost)).toBe(true);
    await gateway.close();
  });

  it('sends prompt=consent only when reconsent is asked', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway, { reconsent: true });
    expect(new URL(begun.body.authorizationUrl).searchParams.get('prompt')).toBe('consent');
    await gateway.close();
  });
});

describe('sign-in complete installs a validated identity (P5b, 5.3)', () => {
  it('signs in, sets welcomeShown in the install write, makes the account active and stores the record encrypted', async () => {
    const gateway = await startPlanGateway();
    const { completed } = await signIn(gateway);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: 'signed_in', firstSignIn: true, account: { label: ACCOUNT, state: 'active', email: gateway.auth.identity.email } });
    const accounts = await gateway.get(PLAN_ROUTES.accounts);
    expect(accounts.body.accounts).toEqual([expect.objectContaining({ label: ACCOUNT, state: 'active', active: true, pinnedBy: ['gpt/plan-model'] })]);
    expect(JSON.stringify(accounts.body)).not.toContain('access_token');
    const records = fs.readdirSync(sessionsDirectory(gateway.home)).filter((name) => name.endsWith('.json'));
    expect(records).toHaveLength(1);
    const raw = fs.readFileSync(path.join(sessionsDirectory(gateway.home), records[0] as string), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ format: 'momonga-credential/1' });
    for (const secret of gateway.auth.issuedSecrets()) expect(raw).not.toContain(secret);
    const active = JSON.parse(fs.readFileSync(momongaLayout(gateway.home).planActive, 'utf8'));
    expect(active).toEqual({ chatgpt: ACCOUNT });

    const again = await signIn(gateway);
    expect(again.completed.body).toMatchObject({ outcome: 'signed_in', firstSignIn: false });
    await gateway.close();
  });

  it('asks a returning account with its saved client id, id_token_hint and login_hint, and no agent_name_hint', async () => {
    const gateway = await startPlanGateway();
    const { callback } = await signIn(gateway);
    const returning = await begin(gateway);
    const params = new URL(returning.body.authorizationUrl).searchParams;
    expect(params.get('client_id')).toBe(callback.searchParams.get('client_id'));
    expect(params.get('id_token_hint')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(params.get('login_hint')).toBe(gateway.auth.identity.email);
    expect(params.has('agent_name_hint')).toBe(false);
    await gateway.close();
  });
});

describe('every way complete ends other than signed_in, plan_disabled and retry has one code, status and text (P5b table)', () => {
  it('attempt_not_found: 404 not_found for an unknown or already consumed attempt', async () => {
    const gateway = await startPlanGateway();
    const { begun, callback } = await signIn(gateway);
    expect(failureOf(await complete(gateway, begun.body.attemptId, callback.toString()))).toEqual({
      status: 404,
      type: 'not_found',
      code: 'attempt_not_found',
      message: 'This sign-in attempt is no longer open.',
    });
    expect(failureOf(await complete(gateway, 'no-such-attempt', callback.toString())).code).toBe('attempt_not_found');
    await gateway.close();
  });

  it('state_mismatch: 400 and nothing exchanged', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    const callback = await browse(begun.body.authorizationUrl);
    const tokenCalls = gateway.auth.calls.tokenAuthorizationCode;
    expect(failureOf(await complete(gateway, begun.body.attemptId, withState(callback, 'f'.repeat(32))))).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'state_mismatch',
      message: 'The sign-in response did not belong to this attempt and was ignored.',
    });
    expect(gateway.auth.calls.tokenAuthorizationCode).toBe(tokenCalls);
    await gateway.close();
  });

  it('access_denied: 400 and no exchange', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    expect(failureOf(await complete(gateway, begun.body.attemptId, callbackWith(begun, { error: 'access_denied' })))).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'access_denied',
      message: 'Sign-in was cancelled in the browser.',
    });
    await gateway.close();
  });

  it('authorization_failed: 400 naming the sanitised OAuth error', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    expect(failureOf(await complete(gateway, begun.body.attemptId, callbackWith(begun, { error: 'server_error<script>' })))).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'authorization_failed',
      message: 'ChatGPT refused the sign-in (server_errorscript).',
    });
    await gateway.close();
  });

  it('registration_incomplete: 400 when a new registration callback has no client_id, and nothing is written', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    const callback = await browse(begun.body.authorizationUrl);
    callback.searchParams.delete('client_id');
    expect(failureOf(await complete(gateway, begun.body.attemptId, callback.toString()))).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'registration_incomplete',
      message: 'ChatGPT did not return an app registration, so nothing was saved.',
    });
    expect(fs.readdirSync(sessionsDirectory(gateway.home)).filter((name) => name.endsWith('.json'))).toEqual([]);
    await gateway.close();
  });

  it('client_mismatch: 400 when a returning callback names another client id, leaving the record unchanged', async () => {
    const gateway = await startPlanGateway();
    await signIn(gateway);
    const before = fs.readdirSync(sessionsDirectory(gateway.home)).map((name) => fs.readFileSync(path.join(sessionsDirectory(gateway.home), name), 'utf8'));
    const returning = await begin(gateway);
    const callback = await browse(returning.body.authorizationUrl);
    callback.searchParams.set('client_id', 'another_client');
    expect(failureOf(await complete(gateway, returning.body.attemptId, callback.toString()))).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'client_mismatch',
      message: 'ChatGPT returned a different app registration than the one saved for this account. The saved account was left unchanged.',
    });
    expect(fs.readdirSync(sessionsDirectory(gateway.home)).map((name) => fs.readFileSync(path.join(sessionsDirectory(gateway.home), name), 'utf8'))).toEqual(before);
    await gateway.close();
  });

  it.each([
    ['wrong_nonce', 'nonce'],
    ['wrong_issuer', 'issuer'],
    ['wrong_audience', 'audience'],
    ['expired', 'expired'],
    ['forged_signature', 'signature'],
    ['alg_none', 'algorithm'],
    ['blank_sub', 'subject'],
  ] as const)('id_token_invalid: 400 naming the failed check for an ID token with %s, and nothing installed', async (flaw, check) => {
    const gateway = await startPlanGateway();
    gateway.auth.idTokenFlaw = flaw;
    const { completed } = await signIn(gateway);
    expect(failureOf(completed)).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'id_token_invalid',
      message: `The identity returned by ChatGPT could not be verified (${check}). Nothing was saved.`,
    });
    const accounts = await gateway.get(PLAN_ROUTES.accounts);
    expect(accounts.body.accounts.filter((account: { state: string }) => account.state === 'active')).toEqual([]);
    await gateway.close();
  });

  it('identity_mismatch: 400 when a returning account signs in as another subject', async () => {
    const gateway = await startPlanGateway();
    await signIn(gateway);
    gateway.auth.subjectOverride = 'someone-else';
    const { completed } = await signIn(gateway);
    expect(failureOf(completed)).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'identity_mismatch',
      message: 'The account that signed in is not the account saved under this label. Nothing was changed.',
    });
    await gateway.close();
  });

  it('plan_disabled: installs and reports it when the required scope was not granted', async () => {
    const gateway = await startPlanGateway();
    gateway.auth.withheldScopes.push(gateway.profile.oauth.requiredScope);
    const { completed } = await signIn(gateway);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: 'plan_disabled', account: { label: ACCOUNT, state: 'plan_disabled' } });
    await gateway.close();
  });
});

describe('the attempt lifecycle (P5b, 5.2)', () => {
  it('replaces a pending attempt that no complete consumed, so the old one is no longer open', async () => {
    const gateway = await startPlanGateway();
    const first = await begin(gateway);
    const firstCallback = await browse(first.body.authorizationUrl);
    const second = await begin(gateway);
    expect(second.body.attemptId).not.toBe(first.body.attemptId);
    expect(failureOf(await complete(gateway, first.body.attemptId, firstCallback.toString())).code).toBe('attempt_not_found');
    await gateway.close();
  });

  it('cancels a pending attempt once and answers every later cancel with cancelled false (O-R5-4 f)', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    const callback = await browse(begun.body.authorizationUrl);
    const first = await gateway.post(PLAN_ROUTES.signInCancel, { attemptId: begun.body.attemptId });
    expect({ status: first.status, body: first.body }).toEqual({ status: 200, body: { cancelled: true } });
    const second = await gateway.post(PLAN_ROUTES.signInCancel, { attemptId: begun.body.attemptId });
    expect({ status: second.status, body: second.body }).toEqual({ status: 200, body: { cancelled: false } });
    const unknown = await gateway.post(PLAN_ROUTES.signInCancel, { attemptId: 'no-such-attempt' });
    expect({ status: unknown.status, body: unknown.body }).toEqual({ status: 200, body: { cancelled: false } });
    expect(failureOf(await complete(gateway, begun.body.attemptId, callback.toString())).code).toBe('attempt_not_found');
    await gateway.close();
  });

  it('answers cancelled false for a consumed attempt and 400 for a body without an attemptId', async () => {
    const gateway = await startPlanGateway();
    const { begun } = await signIn(gateway);
    expect((await gateway.post(PLAN_ROUTES.signInCancel, { attemptId: begun.body.attemptId })).body).toEqual({ cancelled: false });
    const malformed = await gateway.post(PLAN_ROUTES.signInCancel, {});
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.type).toBe('invalid_request');
    await gateway.close();
  });
});

describe('the five sign-in failures settled in O-R5-4', () => {
  it('attempt_expired: a complete at or after expiresAt answers 400 and consumes the attempt', async () => {
    const clock = createFakeClock(Date.now());
    const gateway = await startPlanGateway({ clock });
    const begun = await begin(gateway);
    const callback = await browse(begun.body.authorizationUrl);
    clock.set(Date.parse(begun.body.expiresAt));
    expect(failureOf(await complete(gateway, begun.body.attemptId, callback.toString()))).toEqual({
      status: 400,
      type: 'invalid_request',
      code: 'attempt_expired',
      message: 'This sign-in attempt expired before the browser returned.',
    });
    expect(failureOf(await complete(gateway, begun.body.attemptId, callback.toString())).code).toBe('attempt_not_found');
    await gateway.close();
  });

  it('registration_superseded: 409 for the attempt that installs second, leaving the record of the one that installed first', async () => {
    const gateway = await startPlanGateway();
    const held = holdNextExchange(gateway);
    const first = await begin(gateway);
    const firstCallback = await browse(first.body.authorizationUrl);
    const firstCompleting = complete(gateway, first.body.attemptId, firstCallback.toString());
    await held.reached;
    gateway.auth.subjectOverride = 'second-subject';
    const second = await signIn(gateway);
    expect(second.completed.body).toMatchObject({ outcome: 'signed_in' });
    gateway.auth.subjectOverride = undefined;
    held.release();
    expect(failureOf(await firstCompleting)).toEqual({
      status: 409,
      type: 'invalid_request',
      code: 'registration_superseded',
      message: 'Another sign-in for this account finished first. An app registered during this attempt remains listed in ChatGPT settings; you can remove it there.',
    });
    const accounts = await gateway.get(`${PLAN_ROUTES.accounts}`);
    expect(accounts.body.accounts).toEqual([expect.objectContaining({ label: ACCOUNT, state: 'active' })]);
    await gateway.close();
  });

  it('exchange_unavailable: 502 for a 5xx answer of the code exchange, with no retry and the registration kept', async () => {
    const gateway = await startPlanGateway();
    gateway.auth.scriptToken('authorization_code', [{ kind: 'http', status: 503 }]);
    const { completed } = await signIn(gateway);
    expect(failureOf(completed)).toEqual({ status: 502, type: 'server_error', code: 'exchange_unavailable', message: 'ChatGPT could not be reached to finish the sign-in.' });
    expect(gateway.auth.calls.tokenAuthorizationCode).toBe(1);
    const accounts = await gateway.get(PLAN_ROUTES.accounts);
    expect(accounts.body.accounts).toEqual([expect.objectContaining({ label: ACCOUNT, state: 'registered' })]);
    await gateway.close();
  });

  it('adopts an exchange answer whose expires_in does not exceed the refresh margin (O-R5-5 item 1)', async () => {
    const gateway = await startPlanGateway();
    gateway.auth.scriptToken('authorization_code', [{ kind: 'expires_in', seconds: 121 }]);
    const { completed } = await signIn(gateway);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: ACCOUNT, state: 'active' } });
    await gateway.close();
  });

  it.each([
    [{ kind: 'expires_in', seconds: 0 }, 'the token response has no positive integer expires_in'],
    [{ kind: 'no_replacement_refresh_token' }, 'the token response has no refresh token'],
  ] as const)('token_response_invalid: 502 naming the problem of %j, and nothing saved', async (step, reason) => {
    const gateway = await startPlanGateway();
    gateway.auth.scriptToken('authorization_code', [step]);
    const { completed } = await signIn(gateway);
    expect(failureOf(completed)).toEqual({
      status: 502,
      type: 'server_error',
      code: 'token_response_invalid',
      message: `ChatGPT returned a sign-in response this version cannot use (${reason}). Nothing was saved.`,
    });
    const accounts = await gateway.get(PLAN_ROUTES.accounts);
    expect(accounts.body.accounts.filter((entry: { state: string }) => entry.state === 'active')).toEqual([]);
    await gateway.close();
  });

  it('jwks_unavailable: 502 when the keys request answers 500', async () => {
    const gateway = await startPlanGateway();
    gateway.auth.scriptJwks([{ kind: 'http', status: 500 }]);
    const { completed } = await signIn(gateway);
    expect(failureOf(completed)).toEqual({
      status: 502,
      type: 'server_error',
      code: 'jwks_unavailable',
      message: 'The keys needed to verify the identity returned by ChatGPT could not be fetched.',
    });
    await gateway.close();
  });
});

describe('the {error} of authorization_failed and exchange_rejected is sanitised (O-R5-4 e)', () => {
  const LONG = 'a'.repeat(70);

  it.each([
    ['server_error<script>', 'server_errorscript'],
    ['<>!', 'unspecified'],
    [LONG, 'a'.repeat(64)],
  ])('authorization_failed shows %j as %j', async (raw, shown) => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    expect(failureOf(await complete(gateway, begun.body.attemptId, callbackWith(begun, { error: raw, error_description: 'never shown' }))).message).toBe(
      `ChatGPT refused the sign-in (${shown}).`,
    );
    await gateway.close();
  });

  it.each([
    [{ kind: 'http', status: 400, body: JSON.stringify({ error: 'bad grant!', error_description: 'never shown' }) }, 'badgrant'],
    [{ kind: 'http', status: 400, body: JSON.stringify({ error: '<>' }) }, 'unspecified'],
    [{ kind: 'http', status: 403, body: '{}' }, 'http_403'],
    [{ kind: 'http', status: 400, body: JSON.stringify({ error: LONG }) }, 'a'.repeat(64)],
  ] as const)('exchange_rejected shows the token answer %j as %j', async (step, shown) => {
    const gateway = await startPlanGateway();
    gateway.auth.scriptToken('authorization_code', [step]);
    const { completed } = await signIn(gateway);
    expect(failureOf(completed)).toEqual({ status: 400, type: 'invalid_request', code: 'exchange_rejected', message: `ChatGPT rejected the sign-in code (${shown}).` });
    await gateway.close();
  });
});

describe('nothing depends on the form of the access token (O-R5-6 F)', () => {
  it('signs in, sends a request and refreshes with an opaque access token', async () => {
    const clock = createFakeClock(Date.now());
    const gateway = await startPlanGateway({ accessTokenForm: 'opaque', clock, models: [{ slug: 'listed-model', display_name: 'Listed Model', visibility: 'list', context_window: 200000 }] });
    const { completed } = await signIn(gateway);
    expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: ACCOUNT } });
    const modelsRoute = `${accountRoute(PLAN_ROUTES.accountModels)}?profile=chatgpt&refresh=1`;
    const bearers = (): string[] => gateway.upstream.requests.map((request) => String(request.headers['authorization'] ?? ''));

    expect((await gateway.get(modelsRoute)).status).toBe(200);
    clock.advance(86_400_000);
    const refreshesBefore = gateway.auth.calls.tokenRefreshToken;
    expect((await gateway.get(modelsRoute)).status).toBe(200);

    expect(gateway.auth.calls.tokenRefreshToken).toBe(refreshesBefore + 1);
    const sent = bearers();
    expect(sent).toHaveLength(2);
    for (const bearer of sent) expect(bearer).toMatch(/^Bearer [A-Za-z0-9_-]+$/);
    expect(sent[0]).not.toBe(sent[1]);
    await gateway.close();
  });
});
