import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { getJson } from './gateway-helpers.ts';
import { clientFor } from './gateway-process-helpers.ts';
import { accountRoute, signIn, startPlanGateway } from './plan-signin-support.ts';

const LISTED = [
  { slug: 'reported-model', display_name: 'Reported Model', visibility: 'list', context_window: 200000 },
  { slug: 'silent-model', display_name: 'Silent Model', visibility: 'list' },
  { slug: 'hidden-model', display_name: 'Hidden Model', visibility: 'hide', context_window: 100000 },
];

const NO_WINDOW = 'the server reports no context window for this model';

describe('the live model catalog of a signed-in account (P7, M2a, I-M2)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('lists the server models in order through the probe reader, marks an entry without a window unusable, and filters by visibility', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    const listed = await gateway.get(accountRoute(PLAN_ROUTES.accountModels));
    expect(listed.status).toBe(200);
    expect(listed.body.models).toEqual([
      { slug: 'reported-model', displayName: 'Reported Model', usable: true, contextWindow: 200000, maxOutputTokens: 50000 },
      { slug: 'silent-model', displayName: 'Silent Model', usable: false, reason: NO_WINDOW },
    ]);
    const catalogCall = gateway.upstream.requests.find((request) => request.method === 'GET' && request.path === '/v1/models');
    expect(String(catalogCall?.headers['authorization'] ?? '')).toMatch(/^Bearer \S+/);
    await gateway.close();
  });

  it('saves the capability record named by profile and account, with no secret and no defaulted window', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    await gateway.get(accountRoute(PLAN_ROUTES.accountModels));
    const file = path.join(gateway.home, '.momonga', 'state', 'plan-catalog', 'chatgpt-work.json');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record.models).toEqual({
      'reported-model': { contextWindow: 200000, maxOutputTokens: 50000, source: 'reported' },
      'silent-model': { unreported: true },
    });
    expect(typeof record.readAt).toBe('string');
    for (const secret of gateway.auth.issuedSecrets()) expect(JSON.stringify(record)).not.toContain(secret);
    await gateway.close();
  });

  it('loads the record at gateway start, so a plan target with no declared window takes the reported one', async () => {
    const gateway = await startPlanGateway({ models: LISTED, declaredCapabilities: false });
    await signIn(gateway);
    await gateway.get(accountRoute(PLAN_ROUTES.accountModels));
    const upstreamCalls = gateway.upstream.requests.length;
    await gateway.restart();
    const health = await getJson(clientFor(gateway.socketPath), '/v1/momonga/health');
    expect(health.body.targets['gpt'].reason).not.toBe('capabilities_unknown');
    expect(gateway.upstream.requests.length).toBe(upstreamCalls);
    await gateway.close();
  });

  it('creates a target for a listed model through accounts/{account}/targets', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    await gateway.get(accountRoute(PLAN_ROUTES.accountModels));
    const created = await gateway.post(accountRoute(PLAN_ROUTES.accountTargets), { profile: 'chatgpt', slug: 'reported-model' });
    expect(created.status).toBe(200);
    expect(typeof created.body.target).toBe('string');
    expect(typeof created.body.alias).toBe('string');
    const settings = JSON.parse(fs.readFileSync(path.join(gateway.home, '.momonga', 'settings.json'), 'utf8'));
    expect(settings.models.targets[created.body.target]).toMatchObject({ adapter: 'open-responses', model: 'reported-model', plan: { profile: 'chatgpt', account: 'work' } });
    await gateway.close();
  });
});
