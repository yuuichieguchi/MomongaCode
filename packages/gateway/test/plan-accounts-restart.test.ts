import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ACCOUNT, begin, browse, sessionsDirectory, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';
import { PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SPARE = 'spare';

const recordsOf = (gateway: PlanGateway): string[] =>
  fs
    .readdirSync(sessionsDirectory(gateway.home))
    .filter((name) => name.endsWith('.json'))
    .sort();

const signInSpare = async (gateway: PlanGateway): Promise<void> => {
  const begun = await begin(gateway, { account: SPARE });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  const completed = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
  expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: SPARE } });
};

const makeWorkActive = async (gateway: PlanGateway): Promise<void> => {
  const moved = await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT });
  expect(moved.status).toBe(200);
};

describe('the accounts route lists every stored account of this home, also after a restart (P6.4, 5.5)', () => {
  it('lists an account that is not pinned, not active and not touched since the restart', async () => {
    const gateway = await startPlanGateway();
    expect((await signIn(gateway)).completed.status).toBe(200);
    await signInSpare(gateway);
    await makeWorkActive(gateway);
    const stored = recordsOf(gateway);
    expect(stored).toHaveLength(2);

    await gateway.restart();

    expect(recordsOf(gateway)).toEqual(stored);
    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect(listed.status).toBe(200);
    expect(listed.body.accounts).toHaveLength(2);
    expect(listed.body.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile: PROFILE_ID, label: ACCOUNT, state: 'active', active: true, pinnedBy: ['gpt'] }),
        expect.objectContaining({ profile: PROFILE_ID, label: SPARE, email: gateway.auth.identity.email, state: 'active', active: false, pinnedBy: [] }),
      ]),
    );
    await gateway.close();
  });

  it('lists a signed-out account as registered after a restart', async () => {
    const gateway = await startPlanGateway();
    expect((await signIn(gateway)).completed.status).toBe(200);
    await signInSpare(gateway);
    await makeWorkActive(gateway);
    const signedOut = await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: SPARE });
    expect(signedOut.status).toBe(200);
    const stored = recordsOf(gateway);
    expect(stored).toHaveLength(2);

    await gateway.restart();

    expect(recordsOf(gateway)).toEqual(stored);
    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect(listed.body.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ profile: PROFILE_ID, label: SPARE, state: 'registered', active: false, pinnedBy: [] })]),
    );
    await gateway.close();
  });
});
