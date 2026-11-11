import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import { planProfileOf } from '@momonga/config';
import { PLAN_CREDENTIAL_UNAVAILABLE_CODE } from '@momonga/protocol';
import type { AdapterRequest, AdapterTarget, StreamEvent } from '@momonga/protocol';
import { UNCONFIGURED_NETWORK, UNDICI_DEFAULT_LIVENESS, createFakeClock, planErrorHttpReply, planErrorStreamReply, startFakePlanResponses } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { StreamFailure, UpstreamHttpError } from '../../src/adapters/shared/failures.ts';
import { PlanCredentialError } from '../../src/plan/auth-source.ts';
import type { AuthSource } from '../../src/plan/auth-source.ts';
import { START_MS, registerCleanup } from '../gateway-helpers.ts';
import { contextOf } from '../own-reasoning.ts';
import { PLAN_CAPABILITIES, fakeAuth, posts, startPlan } from '../plan-auth-support.ts';

const USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded';
const REQUEST: AdapterRequest = { model: 'plan-model', input: [{ type: 'message', role: 'user', content: 'hi' }] };
const TARGET: AdapterTarget = { name: 'scripted/plan-model', display: 'scripted/plan-model', model: 'plan-model' };

const storeDoesNotAnswer = new PlanCredentialError(PLAN_CREDENTIAL_UNAVAILABLE_CODE, 'the sign-in record store did not answer', false);

const authWithSilentStore = (): AuthSource & { pauseCalls: number } => {
  const auth = Object.assign(fakeAuth({ renew: false }), { pauseCalls: 0 });
  auth.pause = async () => {
    auth.pauseCalls += 1;
    throw storeDoesNotAnswer;
  };
  return auth;
};

const failureOf = async (auth: AuthSource, reply: FakeUpstreamReply): Promise<unknown> => {
  const fake = await startFakePlanResponses({ verifyBearer: () => 'valid', script: [reply] });
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
  const seen: StreamEvent[] = [];
  try {
    for await (const event of adapter.create(REQUEST, await contextOf(adapter, TARGET))) seen.push(event);
  } catch (error) {
    return error;
  }
  throw new Error(`the call ended without a failure after ${seen.map((event) => event.type).join(', ')}`);
};

describe('a pause that cannot be saved does not replace the usage-limit answer (gateway-core-C36)', () => {
  it('answers the usage limit of the HTTP status, not the failure of the record store', async () => {
    const auth = authWithSilentStore();
    const plan = await startPlan(auth, () => true, [planErrorHttpReply(USAGE_LIMIT, { headers: { 'retry-after': '30' } })]);

    const response = await plan.post();

    expect([response.status, response.body.error.code]).toEqual([429, 'plan_usage_limit']);
    expect(auth.pauseCalls).toBe(1);
    expect(posts(plan.fake)).toHaveLength(1);
  });

  it('answers the usage limit of a failed stream, not the failure of the record store', async () => {
    const auth = authWithSilentStore();
    const plan = await startPlan(auth, () => true, [planErrorStreamReply(USAGE_LIMIT, {})]);

    const response = await plan.post();

    expect(JSON.stringify(response.body)).toContain('plan_usage_limit');
    expect(JSON.stringify(response.body)).not.toContain(PLAN_CREDENTIAL_UNAVAILABLE_CODE);
    expect(auth.pauseCalls).toBe(1);
  });

  it('throws the upstream HTTP failure with the store failure as its cause', async () => {
    const failure = await failureOf(authWithSilentStore(), planErrorHttpReply(USAGE_LIMIT, { headers: { 'retry-after': '30' } }));

    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect((failure as UpstreamHttpError).upstreamCode).toBe(USAGE_LIMIT);
    expect((failure as UpstreamHttpError).cause).toBe(storeDoesNotAnswer);
  });

  it('throws the failure of the stream with the store failure as its cause', async () => {
    const failure = await failureOf(authWithSilentStore(), planErrorStreamReply(USAGE_LIMIT, {}));

    expect(failure).toBeInstanceOf(StreamFailure);
    expect((failure as StreamFailure).code).toBe(USAGE_LIMIT);
    expect((failure as StreamFailure).cause).toBe(storeDoesNotAnswer);
  });
});
