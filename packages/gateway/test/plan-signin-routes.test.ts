import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ACCOUNT, CALLBACK_PORT, begin, browse, sessionsDirectory, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';

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

describe('sign-in begin builds the authorization URL from the profile (P5b, 5.1, 5.2)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
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
    expect(params['nonce']?.length).toBeGreaterThanOrEqual(22);
    expect(params['state']?.length).toBeGreaterThanOrEqual(22);
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

describe('sign-in complete installs a validated identity (P5b, 5.3)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('signs in, sets welcomeShown in the install write, makes the account active and stores the record encrypted', async () => {
    const gateway = await startPlanGateway();
    const { completed } = await signIn(gateway);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ outcome: 'signed_in', firstSignIn: true, account: { label: ACCOUNT, state: 'active', email: gateway.auth.identity.email } });
    const accounts = await gateway.get(PLAN_ROUTES.accounts);
    expect(accounts.body.accounts).toEqual([expect.objectContaining({ label: ACCOUNT, state: 'active', active: true, pinnedBy: ['gpt'] })]);
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

describe('every way complete ends other than signed_in, plan_disabled and retry has one code, status and text (P5b table)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
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

describe('the attempt lifecycle (P5b, 5.2)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('replaces a pending attempt that no complete consumed, so the old one is no longer open', async () => {
    const gateway = await startPlanGateway();
    const first = await begin(gateway);
    const firstCallback = await browse(first.body.authorizationUrl);
    const second = await begin(gateway);
    expect(second.body.attemptId).not.toBe(first.body.attemptId);
    expect(failureOf(await complete(gateway, first.body.attemptId, firstCallback.toString())).code).toBe('attempt_not_found');
    await gateway.close();
  });

  it('cancels an attempt through sign-in/cancel', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    const callback = await browse(begun.body.authorizationUrl);
    expect((await gateway.post(PLAN_ROUTES.signInCancel, { attemptId: begun.body.attemptId })).status).toBe(200);
    expect(failureOf(await complete(gateway, begun.body.attemptId, callback.toString())).code).toBe('attempt_not_found');
    await gateway.close();
  });
});
