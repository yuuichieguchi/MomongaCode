import { describe, expect, it, vi } from 'vitest';
import type { JsonLogger, LogFields } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, openResponsesTextReply, planErrorHttpReply } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { userInput } from './gateway-helpers.ts';
import { clientFor } from './gateway-process-helpers.ts';
import { ACCOUNT, CALLBACK_PORT, accountRoute, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway, PlanGatewayOptions } from './plan-signin-support.ts';
import { CONDITION_WAIT, PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Event = { name: string; data: Record<string, unknown> };

const EVENT_NAMES = ['plan.sign_in', 'plan.refresh', 'plan.rejected', 'plan.sign_out', 'plan.pause', 'plan.catalog'] as const;

const FIELDS: Readonly<Record<(typeof EVENT_NAMES)[number], readonly string[]>> = {
  'plan.sign_in': ['profile', 'account', 'outcome', 'failure', 'step', 'durationMs', 'port', 'alg', 'kid', 'audShape', 'scope', 'earliestRefreshAt', 'claimNames'],
  'plan.refresh': ['profile', 'account', 'outcome', 'code', 'attempts', 'latencyMs', 'remainingMs', 'earliestRefreshAt', 'at'],
  'plan.rejected': ['profile', 'account', 'generation', 'answer'],
  'plan.sign_out': ['profile', 'account', 'revocation', 'resumed'],
  'plan.pause': ['profile', 'account', 'code', 'until'],
  'plan.catalog': ['profile', 'account', 'outcome', 'count', 'usable', 'entryKeys', 'requestIdHeaders'],
};

const recordingLogger = (events: Event[]): JsonLogger => {
  const take = (msg: string, fields?: LogFields): void => {
    if (!(EVENT_NAMES as readonly string[]).includes(msg)) return;
    const data = (fields as { data?: Record<string, unknown> } | undefined)?.data ?? {};
    events.push({ name: msg, data });
  };
  return { debug: take, info: take, warn: take, error: take };
};

type Observed = { gateway: PlanGateway; events: Event[]; secrets(): string[] };

const observed = async (options: PlanGatewayOptions = {}): Promise<Observed> => {
  const events: Event[] = [];
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
    ].filter((value) => value !== '');
  return { gateway, events, secrets };
};

const named = (events: readonly Event[], name: string): Event[] => events.filter((event) => event.name === name);

const presentKeys = (event: Event): string[] => Object.keys(event.data).filter((key) => event.data[key] !== undefined).sort();

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
    body: JSON.stringify({ model: 'default', input: userInput('hi'), stream: false }),
  });
  await response.text();
  return response.status;
};

const LISTED = [{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list', context_window: 200000 }];

describe('O-R5-6 L10: the plan events, their fields and what they never carry', () => {
  it('plan.sign_in carries exactly the fields of a signed-in outcome', async () => {
    const observation = await observed();
    const [event, ...rest] = named(observation.events, 'plan.sign_in');
    expect(rest).toEqual([]);
    if (event === undefined) throw new Error('no plan.sign_in event was written');
    expect(presentKeys(event)).toEqual(['account', 'alg', 'audShape', 'claimNames', 'durationMs', 'earliestRefreshAt', 'kid', 'outcome', 'port', 'profile', 'scope', 'step']);
    const claims = idTokenClaims(observation.gateway);
    expect(event.data).toMatchObject({
      profile: PROFILE_ID,
      account: ACCOUNT,
      outcome: 'signed_in',
      step: 10,
      port: CALLBACK_PORT,
      alg: 'RS256',
      kid: observation.gateway.auth.jwks().keys[0]?.kid,
      audShape: 'string',
      scope: claims['scope'],
      claimNames: Object.keys(claims).sort(),
    });
    expect(typeof event.data['durationMs']).toBe('number');
    expect(event.data['earliestRefreshAt']).toMatch(/^opaque-\d+-[0-9a-f]{8}$/);
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
    expect(event.data['earliestRefreshAt']).toMatch(/^opaque-\d+-[0-9a-f]{8}$/);
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
    const observation = await observed({ verifyBearer, respond });
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

  it('plan.sign_out carries exactly profile, account, revocation and resumed', async () => {
    const observation = await observed();
    expect((await observation.gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT })).status).toBe(200);
    await vi.waitFor(() => expect(named(observation.events, 'plan.sign_out')).toHaveLength(1), CONDITION_WAIT);
    const [event] = named(observation.events, 'plan.sign_out');
    if (event === undefined) throw new Error('no plan.sign_out event was written');
    expect(presentKeys(event)).toEqual(['account', 'profile', 'resumed', 'revocation']);
    expect(event.data).toEqual({ profile: PROFILE_ID, account: ACCOUNT, revocation: 'confirmed', resumed: false });
    expectNoSecret(observation);
    await observation.gateway.close();
  });

  it('plan.pause carries profile, account, code and, with a Retry-After, until', async () => {
    const clock = createFakeClock(Date.now());
    const respond = (): FakeUpstreamReply => planErrorHttpReply('subscription_sharing_usage_limit_exceeded', { headers: { 'retry-after': '30' } });
    const observation = await observed({ clock, respond });
    expect(await ask(observation.gateway)).toBe(429);
    const [event, ...rest] = named(observation.events, 'plan.pause');
    expect(rest).toEqual([]);
    if (event === undefined) throw new Error('no plan.pause event was written');
    expect(presentKeys(event)).toEqual(['account', 'code', 'profile', 'until']);
    expect(event.data).toMatchObject({ profile: PROFILE_ID, account: ACCOUNT, until: new Date(clock.now() + 30_000).toISOString() });
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
    expect(presentKeys(event)).toEqual(expect.arrayContaining(['account', 'count', 'entryKeys', 'outcome', 'profile', 'usable']));
    expect(event.data).toMatchObject({ profile: PROFILE_ID, account: ACCOUNT, outcome: 'ok', count: 1, entryKeys: ['context_window', 'display_name', 'slug', 'visibility'] });
    expect(JSON.stringify(event)).not.toContain('Plan Model');
    expectNoSecret(observation);
    await observation.gateway.close();
  });
});
