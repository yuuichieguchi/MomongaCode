import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createOpenResponsesAdapter, keyAuthSource } from '@momonga/gateway';
import { planProfileOf } from '@momonga/config';
import type { Capabilities } from '@momonga/protocol';
import {
  PLAN_RESPONSES_PATH,
  UNCONFIGURED_NETWORK,
  UNDICI_DEFAULT_LIVENESS,
  anthropicTextReply,
  createFakeClock,
  openResponsesTextReply,
  planErrorHttpReply,
  planErrorStreamReply,
  startFakeAnthropic,
  startFakePlanResponses,
} from '@momonga/testkit';
import type { FakePlanResponses, FakeUpstreamReply } from '@momonga/testkit';
import { PlanCredentialError } from '../src/plan/auth-source.ts';
import type { AuthSource, PlanRead } from '../src/plan/auth-source.ts';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const PLAN_CAPABILITIES: Capabilities = { ...REMOTE_CAPABILITIES, sampling: { accepts: 'none' }, outputBoundField: 'none', systemRole: 'developer', toolPlacement: 'additional_tools' };

const bearerOf = (generation: number): string => `plan-access-generation-${generation}`;

type FakeAuth = AuthSource & { rejectedCalls: number[]; pauses: Array<{ untilMs?: number }>; reads: number };

const fakeAuth = (options: { renew: boolean; failRead?: PlanCredentialError }): FakeAuth => {
  let generation = 1;
  const auth: FakeAuth = {
    rejectedCalls: [],
    pauses: [],
    reads: 0,
    read: async (): Promise<PlanRead> => {
      auth.reads += 1;
      if (options.failRead !== undefined) throw options.failRead;
      return { bearer: bearerOf(generation), generation };
    },
    rejected: async (seen) => {
      auth.rejectedCalls.push(seen);
      if (!options.renew || seen !== generation) return 'unchanged';
      generation += 1;
      return 'renewed';
    },
    pause: async (pause) => {
      auth.pauses.push(pause);
    },
    resume: async () => {},
    status: () => ({ state: 'active' }),
    health: () => ({ ok: true }),
  };
  return auth;
};

const startPlan = async (auth: AuthSource, accepted: (bearer: string | undefined) => boolean, script: FakeUpstreamReply[]) => {
  const fake = await startFakePlanResponses({ verifyBearer: (bearer) => (accepted(bearer) ? 'valid' : 'expired'), script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: `${fake.origin}/v1`, network: UNCONFIGURED_NETWORK }),
    capabilities: async () => PLAN_CAPABILITIES,
    clock: createFakeClock(START_MS),
    authSource: () => auth,
    errorRules: planProfileOf('chatgpt').errorRules,
  });
  registerCleanup(() => adapter.close());
  const harness = await startGateway({ adapters: { plan: adapter }, config: { aliases: { fast: ['plan'] }, targets: { plan: { model: 'plan-model', billing: 'plan' } }, retry: { maxAttempts: 1, totalWaitMs: 1 } } });
  const post = async () => readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
  return { fake, post };
};

const posts = (fake: FakePlanResponses) => fake.requests.filter((request) => request.method === 'POST' && request.path === PLAN_RESPONSES_PATH);

describe('the open-responses adapter takes its bearer from the target AuthSource (P5a-w, M1)', () => {
  it('sends the bearer read from the AuthSource', async () => {
    const auth = fakeAuth({ renew: false });
    const plan = await startPlan(auth, (bearer) => bearer === bearerOf(1), [openResponsesTextReply(['ok'])]);
    const response = await plan.post();
    expect(response.status).toBe(200);
    expect(posts(plan.fake)[0]?.headers['authorization']).toBe(`Bearer ${bearerOf(1)}`);
    expect(auth.reads).toBe(1);
  });

  it('on a 401 reports the generation it sent and repeats the POST once with the renewed bearer', async () => {
    const auth = fakeAuth({ renew: true });
    const plan = await startPlan(auth, (bearer) => bearer === bearerOf(2), [openResponsesTextReply(['ok'])]);
    const response = await plan.post();
    expect(response.status).toBe(200);
    expect(auth.rejectedCalls).toEqual([1]);
    expect(posts(plan.fake).map((request) => request.headers['authorization'])).toEqual([`Bearer ${bearerOf(1)}`, `Bearer ${bearerOf(2)}`]);
  });

  it('surfaces plan_credential_rejected after one POST when the AuthSource answers unchanged', async () => {
    const auth = fakeAuth({ renew: false });
    const plan = await startPlan(auth, () => false, []);
    const response = await plan.post();
    expect(response.body.error.code).toBe('plan_credential_rejected');
    expect(auth.rejectedCalls).toEqual([1]);
    expect(posts(plan.fake)).toHaveLength(1);
  });

  it('surfaces plan_credential_rejected when the renewed bearer is refused too, without a second renewal', async () => {
    const auth = fakeAuth({ renew: true });
    const plan = await startPlan(auth, () => false, []);
    const response = await plan.post();
    expect(response.body.error.code).toBe('plan_credential_rejected');
    expect(auth.rejectedCalls).toEqual([1]);
    expect(posts(plan.fake)).toHaveLength(2);
  });
});

describe('the adapter applies the profile errorRules and their credential effect (P5a-w, M4, M7)', () => {
  it('classifies a usage limit by the profile rules and pauses the account until the Retry-After time', async () => {
    const auth = fakeAuth({ renew: false });
    const plan = await startPlan(auth, () => true, [planErrorHttpReply('subscription_sharing_usage_limit_exceeded', { headers: { 'retry-after': '30' } })]);
    const response = await plan.post();
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('plan_usage_limit');
    expect(auth.pauses).toEqual([{ untilMs: START_MS + 30_000 }]);
    expect(posts(plan.fake)).toHaveLength(1);
  });

  it('fails at once with plan_usage_paused and sends nothing while the account is paused', async () => {
    const auth = fakeAuth({ renew: false, failRead: new PlanCredentialError('plan_usage_paused', 'Usage limit reached', false) });
    const plan = await startPlan(auth, () => true, [openResponsesTextReply(['never'])]);
    const response = await plan.post();
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('plan_usage_paused');
    expect(posts(plan.fake)).toHaveLength(0);
  });

  it('answers a paused read with 429 and retry-after from the pause end, and no POST', async () => {
    const paused = Object.assign(new PlanCredentialError('plan_usage_paused', 'Usage limit reached', false), { retryAfterMs: 30_000 });
    const auth = fakeAuth({ renew: false, failRead: paused });
    const plan = await startPlan(auth, () => true, [openResponsesTextReply(['never'])]);
    const response = await plan.post();
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(posts(plan.fake)).toHaveLength(0);
  });

  it('pauses on a response.failed usage code as on the HTTP answer, with no end when no Retry-After came', async () => {
    const auth = fakeAuth({ renew: false });
    const plan = await startPlan(auth, () => true, [planErrorStreamReply('subscription_sharing_usage_limit_exceeded', {})]);
    const response = await plan.post();
    expect(JSON.stringify(response.body)).toContain('plan_usage_limit');
    expect(auth.pauses).toEqual([{}]);
    expect(posts(plan.fake)).toHaveLength(1);
  });
});

describe('a key target authenticates through the same AuthSource (P5a-w, M1, O-R5-3 e)', () => {
  it('sends its header once and does not retry a 401', async () => {
    const fake = await startFakePlanResponses({ verifyBearer: () => 'revoked', script: [] });
    registerCleanup(() => fake.close());
    const adapter = createOpenResponsesAdapter({
      liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: `${fake.origin}/v1`, network: UNCONFIGURED_NETWORK }),
      capabilities: async () => REMOTE_CAPABILITIES,
      clock: createFakeClock(START_MS),
      authSource: keyAuthSource(async () => 'key-target-value'),
    });
    registerCleanup(() => adapter.close());
    const harness = await startGateway({ adapters: { key: adapter }, config: { aliases: { fast: ['key'] }, targets: { key: { model: 'key-model' } }, retry: { maxAttempts: 1, totalWaitMs: 1 } } });
    const response = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(401);
    expect(posts(fake).map((request) => request.headers['authorization'])).toEqual(['Bearer key-target-value']);
  });

  it('gives anthropic its x-api-key from the same source', async () => {
    const fake = await startFakeAnthropic({ apiKey: 'anthropic-key-value', script: [anthropicTextReply(['ok'])] });
    registerCleanup(() => fake.close());
    const adapter = createAnthropicAdapter({
      liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: fake.socketPath }),
      authSource: keyAuthSource(async () => 'anthropic-key-value'),
      capabilities: async () => REMOTE_CAPABILITIES,
      clock: createFakeClock(START_MS),
      apiVersion: '2026-10-21',
    });
    registerCleanup(() => adapter.close());
    const harness = await startGateway({ adapters: { claude: adapter }, config: { aliases: { fast: ['claude'] }, targets: { claude: { model: 'claude-model' } } } });
    const response = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(200);
    expect(fake.requests[0]?.headers['x-api-key']).toBe('anthropic-key-value');
  });
});
