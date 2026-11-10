import { createOpenResponsesAdapter } from '@momonga/gateway';
import { planProfileOf } from '@momonga/config';
import type { Capabilities, PlanAccountRef } from '@momonga/protocol';
import { PLAN_RESPONSES_PATH, UNCONFIGURED_NETWORK, UNDICI_DEFAULT_LIVENESS, createFakeClock, startFakePlanResponses } from '@momonga/testkit';
import type { FakePlanResponses, FakeUpstreamReply } from '@momonga/testkit';
import type { PlanCredentialError } from '../src/plan/auth-source.ts';
import type { AuthSource, PlanRead } from '../src/plan/auth-source.ts';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import type { ConfigOverrides } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

export const PLAN_CAPABILITIES: Capabilities = { ...REMOTE_CAPABILITIES, sampling: { accepts: 'none' }, outputBoundField: 'none', systemRole: 'developer', toolPlacement: 'additional_tools' };

export const RESOLVED_ACCOUNT: PlanAccountRef = { profile: 'chatgpt', account: 'work' };

export const bearerOf = (generation: number): string => `plan-access-generation-${generation}`;

export type FakeAuth = AuthSource & { resolvedAccount(): PlanAccountRef | undefined; rejectedCalls: number[]; pauses: Array<{ untilMs?: number; code: string }>; reads: number };

export const fakeAuth = (options: { renew?: boolean; failRead?: PlanCredentialError; account?: PlanAccountRef } = {}): FakeAuth => {
  let generation = 1;
  const auth: FakeAuth = {
    rejectedCalls: [],
    pauses: [],
    reads: 0,
    resolvedAccount: () => ({ ...(options.account ?? RESOLVED_ACCOUNT) }),
    read: async (): Promise<PlanRead> => {
      auth.reads += 1;
      if (options.failRead !== undefined) throw options.failRead;
      return { bearer: bearerOf(generation), generation };
    },
    rejected: async (seen) => {
      auth.rejectedCalls.push(seen);
      if (options.renew !== true || seen !== generation) return 'unchanged';
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

export const startPlan = async (auth: AuthSource, accepted: (bearer: string | undefined) => boolean, script: FakeUpstreamReply[], retry: ConfigOverrides['retry'] = { maxAttempts: 1, totalWaitMs: 1 }) => {
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
  const harness = await startGateway({ adapters: { 'scripted/plan-model': adapter }, config: { chains: { 'scripted/plan-model': ['scripted/plan-model'] }, targets: { 'scripted/plan-model': { billing: 'plan' } }, retry } });
  const post = async (extra: Record<string, unknown> = {}) => readJson(await postJson(harness.client, '/v1/responses', { model: 'scripted/plan-model', input: userInput('hi'), ...extra }));
  return { fake, post, client: harness.client };
};

export const posts = (fake: FakePlanResponses) => fake.requests.filter((request) => request.method === 'POST' && request.path === PLAN_RESPONSES_PATH);
