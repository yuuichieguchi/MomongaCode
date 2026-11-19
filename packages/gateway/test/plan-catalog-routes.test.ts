import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFileCredentialStore, credentialFileFor, momongaLayout } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { PLAN_HIDDEN_MODELS, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, planModelLongTexts, testKernelLock } from '@momonga/testkit';
import { getJson, listedEntryOf } from './gateway-helpers.ts';
import { clientFor } from './gateway-process-helpers.ts';
import { ACCOUNT, accountRoute, recordingLogger, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway, RecordedEvent } from './plan-signin-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LISTED = [
  { slug: 'reported-model', display_name: 'Reported Model', visibility: 'list', context_window: 200000 },
  { slug: 'silent-model', display_name: 'Silent Model', visibility: 'list' },
  { slug: 'hidden-model', display_name: 'Hidden Model', visibility: 'hide', context_window: 100000 },
];

const LISTED_WITH_TARGET = [...LISTED, { slug: 'plan-model', display_name: 'Plan Model', visibility: 'list', context_window: 200000 }];

const NO_WINDOW = 'the server reports no context window for this model';
const ACCESS_LIFETIME_MS = 3_600_000;
const RECORD_KEY = `chatgpt/${ACCOUNT}`;

const catalogDirectory = (gateway: PlanGateway): string => (momongaLayout(gateway.home, process.platform, process.env) as unknown as { planCatalog: string }).planCatalog;

const readRecord = async (gateway: PlanGateway): Promise<any> => {
  const raw = await createFileCredentialStore(catalogDirectory(gateway), { lock: testKernelLock() }).read(RECORD_KEY, new AbortController().signal);
  return raw === undefined ? undefined : JSON.parse(raw);
};

const modelsRoute = (query = 'profile=chatgpt', account: string = ACCOUNT): string => `${accountRoute(PLAN_ROUTES.accountModels, account)}?${query}`;

const listReads = (gateway: PlanGateway): number => gateway.upstream.requests.filter((request) => request.method === 'GET' && request.path === '/v1/models').length;

const settingsOf = (gateway: PlanGateway): any => JSON.parse(fs.readFileSync(path.join(gateway.home, '.momonga', 'settings.json'), 'utf8'));

describe('the live model catalog of a signed-in account (P7, M2a, I-M2)', () => {
  it('lists the server models in order through the probe reader, marks an entry without a window unusable, and filters by visibility', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    const listed = await gateway.get(modelsRoute());
    expect(listed.status).toBe(200);
    expect(listed.body.models).toEqual([
      { slug: 'reported-model', displayName: 'Reported Model', usable: true, contextWindow: 200000, maxOutputTokens: 50000 },
      { slug: 'silent-model', displayName: 'Silent Model', usable: false, reason: NO_WINDOW },
    ]);
    const catalogCall = gateway.upstream.requests.find((request) => request.method === 'GET' && request.path === '/v1/models');
    expect(String(catalogCall?.headers['authorization'] ?? '')).toMatch(/^Bearer \S+/);
    await gateway.close();
  });

  it('requires the profile in the query and answers plan_account_not_found for an account with no record (O-R5-4 h)', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    const noProfile = await gateway.get(accountRoute(PLAN_ROUTES.accountModels));
    expect(noProfile.status).toBe(400);
    expect(noProfile.body.error.type).toBe('invalid_request');
    const unknown = await gateway.get(modelsRoute('profile=chatgpt', 'nobody'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ type: 'not_found', code: 'plan_account_not_found' });
    await gateway.close();
  });

  it('saves the capability record in the plain store under <profile>/<account>, 0600, with no secret and no defaulted window (O-R5-4 b)', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    const file = credentialFileFor(catalogDirectory(gateway), RECORD_KEY);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const record = await readRecord(gateway);
    expect(record.models).toEqual({
      'reported-model': { contextWindow: 200000, maxOutputTokens: 50000, source: 'reported' },
      'silent-model': { unreported: true },
    });
    expect(Number.isNaN(Date.parse(record.readAt))).toBe(false);
    for (const secret of gateway.auth.issuedSecrets()) expect(fs.readFileSync(file, 'utf8')).not.toContain(secret);
    await gateway.close();
  });

  it('reads a list far larger than the auth document cap, with long texts in every entry, and keeps none of those texts', async () => {
    const realistic = Array.from({ length: 12 }, (_unused, index) => ({ slug: `gpt-real-${index}`, display_name: `GPT Real ${index}`, visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }], ...planModelLongTexts(`gpt-real-${index}`) }));
    expect(Buffer.byteLength(JSON.stringify({ models: [...realistic, ...PLAN_HIDDEN_MODELS] }))).toBeGreaterThan(4 * 256 * 1024);
    const gateway = await startPlanGateway({ models: realistic });
    await signIn(gateway);
    const listed = await gateway.get(modelsRoute());
    expect(listed.status).toBe(200);
    expect(listed.body.models).toEqual(realistic.map((entry) => ({ slug: entry.slug, displayName: entry.display_name, usable: true, contextWindow: 272000, maxOutputTokens: 68000 })));
    const record = await readRecord(gateway);
    expect(Object.keys(record).sort()).toEqual(['models', 'readAt']);
    for (const entry of realistic) expect(record.models[entry.slug]).toEqual({ contextWindow: 272000, maxOutputTokens: 68000, source: 'reported', reasoning: { efforts: ['low'] } });
    const file = fs.readFileSync(credentialFileFor(catalogDirectory(gateway), RECORD_KEY), 'utf8');
    expect(file).not.toContain('coding agent');
    expect(Buffer.byteLength(file)).toBeLessThan(4096);
    await gateway.close();
  });

  it('serves the record while it is younger than the access lifetime, reads again past it, and on refresh=1 (O-R5-4 g)', async () => {
    const clock = createFakeClock(Date.now());
    const gateway = await startPlanGateway({ models: LISTED, clock });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    expect(listReads(gateway)).toBe(1);
    clock.advance(ACCESS_LIFETIME_MS - 1);
    expect((await gateway.get(modelsRoute())).status).toBe(200);
    expect(listReads(gateway)).toBe(1);
    expect((await gateway.get(modelsRoute('profile=chatgpt&refresh=1'))).status).toBe(200);
    expect(listReads(gateway)).toBe(2);
    clock.advance(ACCESS_LIFETIME_MS);
    await gateway.get(modelsRoute());
    expect(listReads(gateway)).toBe(3);
    await gateway.close();
  });

  it('reads again when the wall clock stepped back before the readAt of the record it answered from', async () => {
    const clock = createFakeClock(Date.now());
    const gateway = await startPlanGateway({ models: LISTED, clock });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    expect(listReads(gateway)).toBe(1);
    clock.stepWall(-60_000);
    expect((await gateway.get(modelsRoute())).status).toBe(200);
    expect(listReads(gateway)).toBe(2);
    await gateway.close();
  });

  it('loads the record at gateway start, so a plan target with no declared window takes the reported one without a list read', async () => {
    const gateway = await startPlanGateway({ models: LISTED_WITH_TARGET, declaredCapabilities: false });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    const reads = listReads(gateway);
    await gateway.restart();
    const health = await getJson(clientFor(gateway.socketPath), '/v1/momonga/health');
    expect(health.body.models['gpt/plan-model'].ok).toBe(true);
    expect(health.body.models['gpt/plan-model']).not.toHaveProperty('reason');
    const models = await getJson(clientFor(gateway.socketPath), '/v1/momonga/models');
    expect(models.status).toBe(200);
    expect(listedEntryOf(models.body, 'gpt/plan-model').capabilities['contextWindow']).toBe(200000);
    expect(listReads(gateway)).toBe(reads);
    await gateway.close();
  });

  it('a plan target whose model the record does not list is capabilities_unknown after a restart', async () => {
    const gateway = await startPlanGateway({ models: LISTED, declaredCapabilities: false });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    const reads = listReads(gateway);
    await gateway.restart();
    const health = await getJson(clientFor(gateway.socketPath), '/v1/momonga/health');
    expect(health.body.models['gpt/plan-model']).toMatchObject({ ok: false, reason: 'capabilities_unknown' });
    expect(listReads(gateway)).toBe(reads);
    await gateway.close();
  });

  it('a catalog answer with no list writes plan.catalog list_invalid', async () => {
    const events: RecordedEvent[] = [];
    const gateway = await startPlanGateway({ models: LISTED, catalogListKey: 'items', logger: recordingLogger(events) });
    await signIn(gateway);
    await gateway.get(modelsRoute('profile=chatgpt&refresh=1'));
    const catalog = events.filter((event) => event.name === 'plan.catalog');
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.data['outcome']).toBe('list_invalid');
    expect(Array.isArray(catalog[0]?.data['requestIdHeaders'])).toBe(true);
    expect(catalog[0]?.data).not.toHaveProperty('listed');
    await gateway.close();
  });

  it('a 200 catalog answer whose body is not JSON writes plan.catalog list_invalid with requestIdHeaders', async () => {
    const events: RecordedEvent[] = [];
    const gateway = await startPlanGateway({ models: LISTED, catalogReply: { kind: 'stream', frames: [{ data: 'not a model list' }] }, logger: recordingLogger(events) });
    await signIn(gateway);
    const answered = await gateway.get(modelsRoute('profile=chatgpt&refresh=1'));
    expect(answered.status).not.toBe(200);
    const catalog = events.filter((event) => event.name === 'plan.catalog');
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.data['outcome']).toBe('list_invalid');
    expect(Array.isArray(catalog[0]?.data['requestIdHeaders'])).toBe(true);
    expect(catalog[0]?.data).not.toHaveProperty('listed');
    await gateway.close();
  });

  it('a 429 catalog answer with an empty JSON body that matches no rule of the profile writes plan.catalog unclassified', async () => {
    const events: RecordedEvent[] = [];
    const gateway = await startPlanGateway({ models: LISTED, catalogReply: { kind: 'error', status: 429, body: {} }, logger: recordingLogger(events) });
    expect(gateway.profile.errorRules.some((rule) => rule.match.kind === 'status' && rule.match.status === 429)).toBe(false);
    await signIn(gateway);
    const answered = await gateway.get(modelsRoute('profile=chatgpt&refresh=1'));
    expect(answered.status).toBe(429);
    const catalog = events.filter((event) => event.name === 'plan.catalog');
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.data['outcome']).toBe('unclassified');
    await gateway.close();
  });
});

describe('accounts/{account}/targets adds a model of the plan through the one settings writer (design-model-names 4.11)', () => {
  const add = (gateway: PlanGateway, slug: string) => gateway.post(accountRoute(PLAN_ROUTES.accountTargets), { profile: 'chatgpt', slug });

  it('adds the model under the plan connection of its profile, answers its full reference, and writes nothing the second time', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    const created = await add(gateway, 'reported-model');
    expect({ status: created.status, body: created.body }).toEqual({ status: 200, body: { model: 'chatgpt/reported-model' } });
    const settings = settingsOf(gateway);
    expect(settings.models.connections.at(-1)).toEqual({ adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'reported-model' }] });
    expect(settings.models).not.toHaveProperty('start');
    expect(settings.models).not.toHaveProperty('fallback');
    const before = fs.readFileSync(path.join(gateway.home, '.momonga', 'settings.json'), 'utf8');
    const again = await add(gateway, 'reported-model');
    expect(again.body).toEqual({ model: 'chatgpt/reported-model' });
    expect(fs.readFileSync(path.join(gateway.home, '.momonga', 'settings.json'), 'utf8')).toBe(before);
    await gateway.close();
  });

  it('refuses an unusable entry with plan_model_unusable and an unknown slug with plan_model_unknown', async () => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    const unusable = await add(gateway, 'silent-model');
    expect(unusable.status).toBe(400);
    expect(unusable.body.error).toMatchObject({ type: 'invalid_request', code: 'plan_model_unusable' });
    expect(unusable.body.error.message).toContain(NO_WINDOW);
    const unknown = await add(gateway, 'no-such-model');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ type: 'not_found', code: 'plan_model_unknown' });
    await gateway.close();
  });

  it('lists an entry that reports supported_in_api false as unusable through the API, keeps that reason in the record, and refuses to add it with it; an entry without the field is as before', async () => {
    const models = [
      { slug: 'api-model', display_name: 'API Model', visibility: 'list', context_window: 200000, supported_in_api: true },
      { slug: 'app-only', display_name: 'App Only', visibility: 'list', context_window: 200000, supported_in_api: false },
      { slug: 'unstated', display_name: 'Unstated', visibility: 'list', context_window: 200000 },
    ];
    const gateway = await startPlanGateway({ models });
    await signIn(gateway);
    const listed = await gateway.get(modelsRoute());
    expect(listed.body.models).toEqual([
      { slug: 'api-model', displayName: 'API Model', usable: true, contextWindow: 200000, maxOutputTokens: 50000 },
      { slug: 'app-only', displayName: 'App Only', usable: false, reason: 'not available through the API' },
      { slug: 'unstated', displayName: 'Unstated', usable: true, contextWindow: 200000, maxOutputTokens: 50000 },
    ]);
    expect((await readRecord(gateway)).models['app-only']).toEqual({ unreported: true, reason: 'not available through the API' });
    const refused = await add(gateway, 'app-only');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'plan_model_unusable', message: 'the model app-only cannot be added: not available through the API' });
    await gateway.close();
  });

  it.for(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('a slug that is only an inherited name, %s, is an unknown model and changes no settings', async (slug) => {
    const gateway = await startPlanGateway({ models: LISTED });
    await signIn(gateway);
    await gateway.get(modelsRoute());
    const unknown = await add(gateway, 'no-such-model');
    const before = fs.readFileSync(path.join(gateway.home, '.momonga', 'settings.json'), 'utf8');
    const inherited = await add(gateway, slug);
    expect(inherited.status).toBe(404);
    expect(inherited.body.error).toEqual({ ...unknown.body.error, message: unknown.body.error.message.replace('"no-such-model"', JSON.stringify(slug)) });
    expect(fs.readFileSync(path.join(gateway.home, '.momonga', 'settings.json'), 'utf8')).toBe(before);
    await gateway.close();
  });

  it('a model the server lists under an inherited name is that model, added like any other', async () => {
    const gateway = await startPlanGateway({ models: [...LISTED, { slug: 'constructor', display_name: 'Constructor', visibility: 'list', context_window: 64000 }, { slug: '__proto__', display_name: 'Proto', visibility: 'list', context_window: 32000 }] });
    await signIn(gateway);
    const listed = await gateway.get(modelsRoute());
    expect(listed.body.models.map((entry: { slug: string }) => entry.slug)).toEqual(['reported-model', 'silent-model', 'constructor', '__proto__']);
    expect((await add(gateway, 'constructor')).body).toEqual({ model: 'chatgpt/constructor' });
    const missing = await add(gateway, 'contextWindow');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'plan_model_unknown' });
    await gateway.close();
  });
});
