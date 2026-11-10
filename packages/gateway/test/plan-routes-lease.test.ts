import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { getJson } from './gateway-helpers.ts';
import { clientFor, homePaths, modelsOf } from './gateway-process-helpers.ts';
import { ACCOUNT, accountRoute, begin, browse, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway } from './plan-signin-support.ts';
import { PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SPARE = 'spare';

let writes = 0;

const replaceSettingsText = (home: string, text: string): void => {
  const { root, settings } = homePaths(home);
  writes += 1;
  const temporary = path.join(root, `.plan-routes-lease-${process.pid}-${writes}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, settings);
};

const target = (account: string) => ({ adapter: 'open-responses', model: 'plan-model', capabilities: { contextWindow: 128000, maxOutputTokens: 16000 }, plan: { profile: PROFILE_ID, account } });

const APPLIED = {
  credentials: { plaintextTokenFiles: true },
  models: modelsOf({ gpt: target(ACCOUNT), 'gpt-spare': target(SPARE) }),
};

const completeFor = async (gateway: PlanGateway, account: string) => {
  const begun = await begin(gateway, { account });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  return gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
};

describe('O-R5-6 L6: the routes that read plan targets take the D1 lease and read them from the leased epoch', () => {
  it('the routes that read plan targets take the lease: after a broken settings file the accounts, complete and resume routes answer from the last applied epoch', async () => {
    const gateway = await startPlanGateway({ plaintextTokenFiles: true });
    replaceSettingsText(gateway.home, JSON.stringify(APPLIED));
    expect((await getJson(clientFor(gateway.socketPath), '/v1/momonga/models')).status).toBe(200);
    const work = await completeFor(gateway, ACCOUNT);
    expect(work.status).toBe(200);
    expect(work.body.account).toMatchObject({ label: ACCOUNT, pinnedBy: ['gpt/plan-model'] });

    replaceSettingsText(gateway.home, '{ "models": ');

    const spare = await completeFor(gateway, SPARE);
    expect(spare.status).toBe(200);
    expect(spare.body.account).toMatchObject({ label: SPARE, pinnedBy: ['gpt-spare/plan-model'] });
    const listed = await gateway.get(PLAN_ROUTES.accounts);
    expect(listed.status).toBe(200);
    const pinned = Object.fromEntries((listed.body.accounts as { label: string; pinnedBy: string[] }[]).map((entry) => [entry.label, entry.pinnedBy]));
    expect(pinned).toEqual({ [ACCOUNT]: ['gpt/plan-model'], [SPARE]: ['gpt-spare/plan-model'] });
    const resumed = await gateway.post(accountRoute(PLAN_ROUTES.accountResume, ACCOUNT), { profile: PROFILE_ID });
    expect(resumed.status).toBe(200);

    const third = await begin(gateway, { account: 'third' });
    expect(third.status).toBe(200);
    const cancelled = await gateway.post(PLAN_ROUTES.signInCancel, { attemptId: third.body.attemptId });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: true });
    const active = await gateway.post(PLAN_ROUTES.accountsActive, { profile: PROFILE_ID, account: ACCOUNT });
    expect(active.status).toBe(200);
    expect(active.body).toEqual({ active: { profile: PROFILE_ID, account: ACCOUNT } });
    expect((await gateway.get(`${accountRoute(PLAN_ROUTES.accountModels, ACCOUNT)}?profile=${PROFILE_ID}`)).status).toBe(200);
    expect((await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: SPARE })).status).toBe(200);
    expect((await gateway.post(PLAN_ROUTES.hostReset, {})).status).toBe(200);
    await gateway.close();
  });
});
