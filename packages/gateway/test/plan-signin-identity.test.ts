import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import { ACCOUNT, begin, browse, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const ONE_TIME_AND_STATIC_PARAMETERS = [
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'ext_agent_host_id',
  'nonce',
  'redirect_uri',
  'resource',
  'response_type',
  'scope',
  'state',
];

const exchanged = async (gateway: PlanGateway) => {
  const begun = await begin(gateway);
  const callback = await browse(begun.body.authorizationUrl);
  const answer = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
  return { begun, callback, answer };
};

const confirm = (gateway: PlanGateway, attemptId: string) => gateway.post(PLAN_ROUTES.signInComplete, { attemptId, identityConfirmed: true });

const statesOf = async (gateway: PlanGateway): Promise<string[]> => {
  const accounts = await gateway.get(PLAN_ROUTES.accounts);
  return accounts.body.accounts.map((account: { state: string }) => account.state);
};

describe('the authorization URL carries no identity hint (security-17, gateway-accounts C51)', () => {
  it('asks a returning account with its saved client id and only the one-time values of the attempt', async () => {
    const gateway = await startPlanGateway();
    const { callback } = await signIn(gateway);
    const returning = await begin(gateway);
    const params = new URL(returning.body.authorizationUrl).searchParams;
    expect(params.get('client_id')).toBe(callback.searchParams.get('client_id'));
    expect(params.has('id_token_hint')).toBe(false);
    expect(params.has('login_hint')).toBe(false);
    expect([...params.keys()].sort()).toEqual(ONE_TIME_AND_STATIC_PARAMETERS);
    expect(returning.body.authorizationUrl).not.toContain(encodeURIComponent(gateway.auth.identity.email));
    await gateway.close();
  });
});

describe('the first sign-in of an account is confirmed before it is saved (foundation DECISION-5 option B)', () => {
  it('answers the identity of the exchange and saves no sign-in until it is confirmed', async () => {
    const gateway = await startPlanGateway();
    const { begun, answer } = await exchanged(gateway);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      outcome: 'identity_unconfirmed',
      attemptId: begun.body.attemptId,
      identity: { subject: gateway.auth.identity.sub, email: gateway.auth.identity.email },
      expiresAt: expect.any(String),
    });
    expect(await statesOf(gateway)).toEqual(['registered']);
    expect(fs.existsSync(momongaLayout(gateway.home, process.platform, process.env).planActive)).toBe(false);
    await gateway.close();
  });

  it('saves the sign-in when the identity is confirmed', async () => {
    const gateway = await startPlanGateway();
    const { begun } = await exchanged(gateway);
    const confirmed = await confirm(gateway, begun.body.attemptId);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ outcome: 'signed_in', firstSignIn: true, account: { label: ACCOUNT, state: 'active', email: gateway.auth.identity.email } });
    expect(await statesOf(gateway)).toEqual(['active']);
    await gateway.close();
  });

  it('answers the same identity again when the callback is given a second time', async () => {
    const gateway = await startPlanGateway();
    const { begun, callback, answer } = await exchanged(gateway);
    const again = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
    expect(again.body).toEqual(answer.body);
    expect(await statesOf(gateway)).toEqual(['registered']);
    await gateway.close();
  });

  it('saves nothing when the person cancels instead of confirming, and the attempt is closed', async () => {
    const gateway = await startPlanGateway();
    const { begun } = await exchanged(gateway);
    const cancelled = await gateway.post(PLAN_ROUTES.signInCancel, { attemptId: begun.body.attemptId });
    expect(cancelled.body).toEqual({ cancelled: true });
    const confirmed = await confirm(gateway, begun.body.attemptId);
    expect(confirmed.status).toBe(404);
    expect(confirmed.body.error.code).toBe('attempt_not_found');
    expect(await statesOf(gateway)).toEqual(['registered']);
    await gateway.close();
  });

  it('saves nothing when the confirmation comes after the attempt expired', async () => {
    const clock = createFakeClock(Date.now());
    const gateway = await startPlanGateway({ clock });
    const { begun, answer } = await exchanged(gateway);
    clock.set(Date.parse(answer.body.expiresAt));
    const confirmed = await confirm(gateway, begun.body.attemptId);
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.error.code).toBe('identity_late');
    expect((await confirm(gateway, begun.body.attemptId)).body.error.code).toBe('attempt_not_found');
    expect(await statesOf(gateway)).toEqual(['registered']);
    await gateway.close();
  });

  it('refuses a confirmation given before the exchange and leaves the attempt open', async () => {
    const gateway = await startPlanGateway();
    const begun = await begin(gateway);
    const early = await confirm(gateway, begun.body.attemptId);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('identity_not_exchanged');
    const callback = await browse(begun.body.authorizationUrl);
    const answer = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
    expect(answer.body).toMatchObject({ outcome: 'identity_unconfirmed' });
    await gateway.close();
  });

  it('signs a returning account in without a second confirmation when the saved subject is the one that signed in', async () => {
    const gateway = await startPlanGateway();
    await signIn(gateway);
    const { answer } = await exchanged(gateway);
    expect(answer.body).toMatchObject({ outcome: 'signed_in', firstSignIn: false });
    await gateway.close();
  });

  it('refuses a returning account whose saved subject differs, with no confirmation offered', async () => {
    const gateway = await startPlanGateway();
    await signIn(gateway);
    gateway.auth.subjectOverride = 'someone-else';
    const { answer } = await exchanged(gateway);
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe('identity_mismatch');
    await gateway.close();
  });
});
