import { describe, expect, it, vi } from 'vitest';
import { planProfileOf } from '@momonga/config';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import { PLAN_ROUTES } from '@momonga/protocol';
import type { AdapterRequest, AdapterTarget, PlanAccountRef } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, UNCONFIGURED_NETWORK, UNDICI_DEFAULT_LIVENESS, createFakeClock, openResponsesTextReply, planErrorHttpReply, startFakePlanResponses } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { clientFor } from './gateway-process-helpers.ts';
import { contextOf } from './own-reasoning.ts';
import { PLAN_CAPABILITIES, RESOLVED_ACCOUNT, fakeAuth } from './plan-auth-support.ts';
import type { FakeAuth } from './plan-auth-support.ts';
import { ACCOUNT, begin, browse, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';
import { ACCESS_LIFETIME_MS, MARGIN_MS, PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SPARE = 'spare';

const work: PlanAccountRef = { profile: PROFILE_ID, account: 'work' };
const home: PlanAccountRef = { profile: PROFILE_ID, account: 'home' };

const TARGET_A: AdapterTarget = { name: 'a', model: 'plan-model' };
const TARGET_B: AdapterTarget = { name: 'b', model: 'plan-model' };

const PLAIN_REQUEST: AdapterRequest = { model: 'plan-model', input: [{ type: 'message', role: 'user', content: 'hello' }] };

const ask = async (gateway: PlanGateway) => readJson(await postJson(clientFor(gateway.socketPath), '/v1/responses', { model: 'default', input: userInput('hi') }));

const planAdapter = async (authSource: (target: AdapterTarget) => FakeAuth, script: FakeUpstreamReply[] = []) => {
  const fake = await startFakePlanResponses({ verifyBearer: () => 'valid', script });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({
    liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: `${fake.origin}/v1`, network: UNCONFIGURED_NETWORK }),
    capabilities: async () => PLAN_CAPABILITIES,
    clock: createFakeClock(START_MS),
    authSource,
    errorRules: planProfileOf('chatgpt').errorRules,
  });
  registerCleanup(() => adapter.close());
  return adapter;
};

const signInAs = async (gateway: PlanGateway, account: string): Promise<void> => {
  const begun = await begin(gateway, { account });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  const completed = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
  expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: account } });
};

describe('an error names the account of the part that served the request (P-PLAN)', () => {
  it('a 412 capabilities_unknown on a plan target names the served account on the first request and on the second', async () => {
    const gateway = await startPlanGateway({ declaredCapabilities: false });
    try {
      await signIn(gateway);
      for (const answered of [await ask(gateway), await ask(gateway)]) {
        expect(answered.status).toBe(412);
        expect(answered.body.error.code).toBe('capabilities_unknown');
        expect(answered.body.error.plan).toEqual({ profile: PROFILE_ID, account: ACCOUNT });
      }
    } finally {
      await gateway.close();
    }
  });

  it('an adapter names its served account before any create', async () => {
    const adapter = await planAdapter(() => fakeAuth());
    expect(adapter.servedAccount?.({ name: 'plan', model: 'plan-model' })).toEqual(RESOLVED_ACCOUNT);
  });

  it('one adapter serving two targets names each target\'s own account whichever create ran last', async () => {
    const adapter = await planAdapter((target) => fakeAuth({ account: target.name === 'a' ? work : home }), [openResponsesTextReply(['ok']), openResponsesTextReply(['ok'])]);
    for (const target of [TARGET_A, TARGET_B]) {
      const events: unknown[] = [];
      for await (const event of adapter.create(PLAIN_REQUEST, await contextOf(adapter, target))) events.push(event);
      expect(events.length).toBeGreaterThan(0);
    }
    expect(adapter.servedAccount?.(TARGET_A)).toEqual(work);
    expect(adapter.servedAccount?.(TARGET_B)).toEqual(home);
  });

  it('a request in flight names the account it was admitted with after accounts/active moved', async () => {
    const clock = createFakeClock(Date.now());
    const respond = (): FakeUpstreamReply => planErrorHttpReply('subscription_sharing_unsupported_capability', {});
    const gateway = await startPlanGateway({ clock, pinned: false, respond });
    let reach = (): void => undefined;
    let release = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await signInAs(gateway, ACCOUNT);
      await signInAs(gateway, SPARE);
      expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT })).status).toBe(200);
      clock.advance(ACCESS_LIFETIME_MS - MARGIN_MS);
      gateway.auth.scriptToken('refresh_token', [{ kind: 'hold', reached: reach, released }]);
      const first = ask(gateway);
      await reached;
      expect((await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: SPARE })).status).toBe(200);
      release();
      const firstAnswer = await first;
      expect(firstAnswer.status).toBe(400);
      expect(firstAnswer.body.error.plan.account).toBe(ACCOUNT);
      const secondAnswer = await ask(gateway);
      expect(secondAnswer.status).toBe(400);
      expect(secondAnswer.body.error.plan.account).toBe(SPARE);
    } finally {
      release();
      await gateway.close();
    }
  });
});
