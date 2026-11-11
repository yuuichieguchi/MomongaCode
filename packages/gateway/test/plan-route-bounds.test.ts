import { describe, expect, it, vi } from 'vitest';
import { HOST_READ_BOUND_MS } from '@momonga/foundation';
import { PLAN_ROUTES, PLAN_SIGN_IN_FAILURE } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { PLAN_SIGN_IN_DEFAULTS } from '../src/defaults.ts';
import { PLAN_ROUTE_BODY_BYTES } from '../src/plan/request-limit.ts';
import { boundedHttpServer } from '../src/server/gateway.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { ACCOUNT, CALLBACK_PORT, begin, browse, startPlanGateway } from './plan-signin-support.ts';
import { PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('the plan routes read at most PLAN_ROUTE_BODY_BYTES (N-G2, G2-10)', () => {
  it('the cap is 65 536 bytes', () => {
    expect(PLAN_ROUTE_BODY_BYTES).toBe(65_536);
  });

  it('a 70 000-byte plan body is refused as too large, and a body under the cap is read', async () => {
    const gateway = await startPlanGateway();
    registerCleanup(() => gateway.close());
    const refused = await gateway.post(PLAN_ROUTES.signInBegin, { profile: PROFILE_ID, account: ACCOUNT, port: CALLBACK_PORT, padding: 'x'.repeat(70_000) });
    expect(refused.status).toBe(413);
    expect(refused.body.error.message).toContain(String(PLAN_ROUTE_BODY_BYTES));
    const read = await gateway.post(PLAN_ROUTES.signInBegin, { profile: PROFILE_ID, account: ACCOUNT, port: CALLBACK_PORT, padding: 'x'.repeat(60_000) });
    expect(read.status).toBe(200);
  });

  it('a key set larger than its cap is refused: the sign-in ends jwks_unavailable', async () => {
    const gateway = await startPlanGateway();
    registerCleanup(() => gateway.close());
    const oversized = JSON.stringify({ keys: gateway.auth.jwks().keys, padding: 'k'.repeat(PLAN_SIGN_IN_DEFAULTS.keysBodyBytes) });
    gateway.auth.scriptJwks([{ kind: 'http', status: 200, body: oversized }, { kind: 'http', status: 200, body: oversized }]);
    const begun = await begin(gateway);
    const callback = await browse(begun.body.authorizationUrl);
    const completed = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
    expect(completed.body.error.code).toBe(PLAN_SIGN_IN_FAILURE.jwksUnavailable);
  });
});

describe('both servers of the gateway bound a request that does not finish (N-W1, E-4)', () => {
  it('a server of the gateway has requestTimeout HOST_READ_BOUND_MS, set by the gateway and not left to the runtime default', () => {
    expect(boundedHttpServer(() => undefined).requestTimeout).toBe(HOST_READ_BOUND_MS);
  });
});
