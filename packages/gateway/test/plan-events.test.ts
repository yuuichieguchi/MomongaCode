import { describe, expect, it, vi } from 'vitest';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, openResponsesTextReply, planErrorHttpReply } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { userInput } from './gateway-helpers.ts';
import { clientFor } from './gateway-process-helpers.ts';
import { ACCOUNT, CALLBACK_PORT, PLAN_EVENT_NAMES, accountRoute, recordingLogger, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway, PlanGatewayOptions, RecordedEvent } from './plan-signin-support.ts';
import { CONDITION_WAIT, PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FIELDS: Readonly<Record<(typeof PLAN_EVENT_NAMES)[number], readonly string[]>> = {
  'plan.sign_in': ['profile', 'account', 'outcome', 'failure', 'endStep', 'durationMs', 'port', 'alg', 'kid', 'audShape', 'scope', 'earliestRefreshAt', 'claimNames'],
  'plan.refresh': ['profile', 'account', 'outcome', 'code', 'interrupted', 'attempts', 'latencyMs', 'remainingMs', 'earliestRefreshAt', 'at'],
  'plan.rejected': ['profile', 'account', 'generation', 'answer'],
  'plan.sign_out': ['profile', 'account', 'revocation', 'resumed', 'end', 'code'],
  'plan.pause': ['profile', 'account', 'code', 'until', 'saved'],
  'plan.catalog': ['profile', 'account', 'outcome', 'listed', 'usable', 'entryKeys', 'requestIdHeaders'],
};

type Observed = { gateway: PlanGateway; events: RecordedEvent[]; secrets(): string[] };

const observed = async (options: PlanGatewayOptions = {}): Promise<Observed> => {
  const events: RecordedEvent[] = [];
  const gateway = await startPlanGateway({ ...options, logger: recordingLogger(events) });
  const signedIn = await signIn(gateway);
  const authorization = new URL(signedIn.begun.body.authorizationUrl as string);
  const secrets = (): string[] =>
    [
      ...gateway.auth.issuedSecrets(),
      signedIn.callback.searchParams.get('code') ?? '',
      authorization.searchParams.get('state') ?? '',
      authorization.searchParams.get('nonce') ?? '',
      authorization.toString(),
      signedIn.callback.toString(),
      gateway.auth.identity.email,
      gateway.auth.identity.sub,
      ...gateway.auth.registrations().flatMap((registration) => [registration.clientId, registration.hostId]),
    ].filter((value) => value !== '');
  return { gateway, events, secrets };
};

const named = (events: readonly RecordedEvent[], name: string): RecordedEvent[] => events.filter((event) => event.name === name);

const presentKeys = (event: RecordedEvent): string[] => Object.keys(event.data).filter((key) => event.data[key] !== undefined).sort();

const expectNoSecret = (observation: Observed): void => {
  const text = JSON.stringify(observation.events);
  for (const secret of observation.secrets()) expect(text.includes(secret), 'an event carries a value the design forbids (O-R5-6 L10, I-C1)').toBe(false);
};

const payloadOf = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

const idTokenClaims = (gateway: PlanGateway): Record<string, unknown> => {
  const idToken = gateway.auth.issuedSecrets().find((secret) => secret.split('.').length === 3 && (() => {
    try {
      return 'nonce' in payloadOf(secret);
    } catch {
      return false;
    }
  })());
  if (idToken === undefined) throw new Error('the fake issued no ID token');
  return payloadOf(idToken);
};

const ask = async (gateway: PlanGateway): Promise<number> => {
  const response = await clientFor(gateway.socketPath).request({
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt/plan-model', input: userInput('hi'), stream: false }),
  });
  await response.text();
  return response.status;
};

const LISTED = [{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list', context_window: 200000 }];

describe('O-R5-6 L10: the plan events, their fields and what they never carry', () => {
  it('plan.sign_in carries exactly the fields of a signed-in outcome', async () => {
    const observation = await observed();
    const [unconfirmed, event, ...rest] = named(observation.events, 'plan.sign_in');
    expect(rest).toEqual([]);
    expect(unconfirmed?.data).toMatchObject({ outcome: 'identity_unconfirmed', endStep: 9 });
    if (event === undefined) throw new Error('no plan.sign_in event was written');
    expect(presentKeys(event)).toEqual(['account', 'alg', 'audShape', 'claimNames', 'durationMs', 'earliestRefreshAt', 'endStep', 'kid', 'outcome', 'port', 'profile', 'scope']);
    const claims = idTokenClaims(observation.gateway);
    expect(event.data).toMatchObject({
      profile: PROFILE_ID,
      account: ACCOUNT,
      outcome: 'signed_in',
      endStep: 10,
      port: CALLBACK_PORT,
      alg: 'RS256',
      kid: observation.gateway.auth.jwks().keys[0]?.kid,
      audShape: 'string',
      scope: claims['scope'],
      claimNames: Object.keys(claims).sort(),
    });
    expect(typeof event.data['durationMs']).toBe('number');
    expect(event.data['earliestRefreshAt']).toMatch(/^\d+$/);
    expectNoSecret(observation);
    await observation.gateway.close();
  });

  it('plan.refresh carries exactly the fields of an adopted refresh', async () => {
    const clock = createFakeClock(Date.now());
    const observation = await observed({ clock, models: LISTED });
    const route = `${accountRoute(PLAN_ROUTES.accountModels)}?profile=${PROFILE_ID}&refresh=1`;
    expect((await observation.gateway.get(route)).status).toBe(200);
    clock.advance(86_400_000);
    expect((await observation.gateway.get(route)).status).toBe(200);
    const [event, ...rest] = named(observation.events, 'plan.refresh');
    expect(rest).toEqual([]);
    if (event === undefined) throw new Error('no plan.refresh event was written');
    expect(presentKeys(event)).toEqual(['account', 'at', 'attempts', 'earliestRefreshAt', 'latencyMs', 'outcome', 'profile', 'remainingMs']);
    expect(event.data).toMatchObject({ profile: PROFILE_ID, account: ACCOUNT, outcome: 'adopted', attempts: 1, at: new Date(clock.now()).toISOString() });
    expect(typeof event.data['latencyMs']).toBe('number');
    expect(typeof event.data['remainingMs']).toBe('number');
    expect(event.data['earliestRefreshAt']).toMatch(/^\d+$/);
    expectNoSecret(observation);
    await observation.gateway.close();
  });

  it('plan.rejected carries exactly profile, account, generation and answer', async () => {
    const refused = new Set<string>();
    let first: string | undefined;
    const verifyBearer = (token: string | undefined) => {
      if (first === undefined && token !== undefined) {
        first = token;
        refused.add(token);
      }
      return token !== undefined && refused.has(token) ? ('expired' as const) : ('valid' as const);
    };
    const respond = (): FakeUpstreamReply => openResponsesTextReply(['hi']);
    const clock = createFakeClock(Date.now());
    const observation = await observed({ clock, verifyBearer, respond });
    clock.advance(60_000);
    expect(await ask(observation.gateway)).toBe(200);
    const [event, ...rest] = named(observation.events, 'plan.rejected');
    expect(rest).toEqual([]);
    if (event === undefined) throw new Error('no plan.rejected event was written');
    expect(presentKeys(event)).toEqual(['account', 'answer', 'generation', 'profile']);
    expect(event.data).toMatchObject({ profile: PROFILE_ID, account: ACCOUNT, answer: 'renewed' });
    expect(typeof event.data['generation']).toBe('number');
    expectNoSecret(observation);
    await observation.gateway.close();
  });

  it('plan.sign_out carries exactly profile, account, revocation, resumed and end', async () => {
    const observation = await observed();
    expect((await observation.gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT })).status).toBe(200);
    await vi.waitFor(() => expect(named(observation.events, 'plan.sign_out')).toHaveLength(1), CONDITION_WAIT);
    const [event] = named(observation.events, 'plan.sign_out');
    if (event === undefined) throw new Error('no plan.sign_out event was written');
    expect(presentKeys(event)).toEqual(['account', 'end', 'profile', 'resumed', 'revocation']);
    expect(event.data).toEqual({ profile: PROFILE_ID, account: ACCOUNT, revocation: 'confirmed', resumed: false, end: 'cleared' });
    expectNoSecret(observation);
    await observation.gateway.close();
  });

  it('plan.pause carries profile, account, code, saved and, with a Retry-After, until', async () => {
    const clock = createFakeClock(Date.now());
    const respond = (): FakeUpstreamReply => planErrorHttpReply('subscription_sharing_usage_limit_exceeded', { headers: { 'retry-after': '30' } });
    const observation = await observed({ clock, respond });
    expect(await ask(observation.gateway)).toBe(429);
    const [event, ...rest] = named(observation.events, 'plan.pause');
    expect(rest).toEqual([]);
    if (event === undefined) throw new Error('no plan.pause event was written');
    expect(presentKeys(event)).toEqual(['account', 'code', 'profile', 'saved', 'until']);
    expect(event.data).toMatchObject({ profile: PROFILE_ID, account: ACCOUNT, saved: true, until: new Date(clock.now() + 30_000).toISOString() });
    expect(typeof event.data['code']).toBe('string');
    expectNoSecret(observation);
    await observation.gateway.close();
  });

  it('plan.catalog carries the outcome, the counts and the key names of the listed entries, never their values', async () => {
    const observation = await observed({ models: LISTED });
    expect((await observation.gateway.get(`${accountRoute(PLAN_ROUTES.accountModels)}?profile=${PROFILE_ID}&refresh=1`)).status).toBe(200);
    const [event, ...rest] = named(observation.events, 'plan.catalog');
    expect(rest).toEqual([]);
    if (event === undefined) throw new Error('no plan.catalog event was written');
    for (const key of presentKeys(event)) expect(FIELDS['plan.catalog']).toContain(key);
    expect(presentKeys(event)).toEqual(['account', 'entryKeys', 'listed', 'outcome', 'profile', 'requestIdHeaders', 'usable']);
    expect(event.data).toMatchObject({ profile: PROFILE_ID, account: ACCOUNT, outcome: 'ok', listed: 1, usable: 1, entryKeys: ['context_window', 'display_name', 'slug', 'visibility'] });
    expect(Array.isArray(event.data['requestIdHeaders'])).toBe(true);
    expect(JSON.stringify(event)).not.toContain('Plan Model');
    expectNoSecret(observation);
    await observation.gateway.close();
  });
});
