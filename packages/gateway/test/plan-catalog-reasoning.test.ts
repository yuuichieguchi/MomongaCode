import { describe, expect, it, vi } from 'vitest';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, openResponsesTextReply, planModelLongTexts } from '@momonga/testkit';
import { getJson, listedEntryOf, postJson, readJson, userInput } from './gateway-helpers.ts';
import { clientFor } from './gateway-process-helpers.ts';
import { ACCOUNT, accountRoute, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { PlanGateway, PlanGatewayOptions } from './plan-signin-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PLAN_MODEL = {
  slug: 'plan-model',
  display_name: 'Plan Model',
  visibility: 'list',
  context_window: 272000,
  supported_in_api: true,
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    { effort: 'ultra', description: 'A level this build does not know' },
  ],
  default_reasoning_level: 'high',
  ...planModelLongTexts('plan-model'),
};

const REPORTED = { control: 'reasoning_effort', lowest: 'low', efforts: ['low', 'medium', 'high'], default: 'high' };

const modelsRoute = `${accountRoute(PLAN_ROUTES.accountModels, ACCOUNT)}?profile=chatgpt`;

const started = async (options: PlanGatewayOptions): Promise<PlanGateway> => {
  const gateway = await startPlanGateway({ respond: () => openResponsesTextReply(['ok']), ...options });
  await signIn(gateway);
  expect((await gateway.get(modelsRoute)).status).toBe(200);
  return gateway;
};

const listed = async (gateway: PlanGateway): Promise<ReturnType<typeof listedEntryOf> & { effort?: string }> => listedEntryOf((await getJson(clientFor(gateway.socketPath), '/v1/momonga/models')).body, 'gpt/plan-model');

const sentEffort = async (gateway: PlanGateway, effort: string): Promise<unknown> => {
  const answered = readJson(await postJson(clientFor(gateway.socketPath), '/v1/responses', { model: 'gpt/plan-model', input: userInput('hi'), reasoning: { effort } }));
  expect((await answered).status).toBe(200);
  const sent = gateway.upstream.requests.filter((request) => request.method === 'POST').at(-1)?.body as { reasoning?: { effort: string } } | undefined;
  return sent?.reasoning?.effort;
};

describe('a plan model takes its reasoning control and its default level from the model list', () => {
  it('derives the reported control from the levels the list reports, ignores a level the product does not know, and lists the reported default as the effort', async () => {
    const gateway = await started({ models: [PLAN_MODEL], declaredCapabilities: false });
    const entry = await listed(gateway);
    expect(entry.capabilities['reasoning']).toEqual(REPORTED);
    expect(entry.effort).toBe('high');
    expect(entry.chain[0]?.capabilities['reasoning']).toEqual(REPORTED);
    await gateway.close();
  });

  it('sends the level a run carries, the listed default or a chosen one, clamped to the reported levels', async () => {
    const gateway = await started({ models: [PLAN_MODEL], declaredCapabilities: false });
    expect(await sentEffort(gateway, 'high')).toBe('high');
    expect(await sentEffort(gateway, 'low')).toBe('low');
    expect(await sentEffort(gateway, 'xhigh')).toBe('high');
    await gateway.close();
  });

  it('keeps the reported reasoning after a restart from the record, without a list read', async () => {
    const gateway = await started({ models: [PLAN_MODEL], declaredCapabilities: false });
    await gateway.restart();
    const entry = await listed(gateway);
    expect(entry.capabilities['reasoning']).toEqual(REPORTED);
    expect(entry.effort).toBe('high');
    await gateway.close();
  });

  it('reads the reported reasoning when the settings declare only the numbers', async () => {
    const gateway = await started({ models: [PLAN_MODEL] });
    const entry = await listed(gateway);
    expect(entry.capabilities['contextWindow']).toBe(128000);
    expect(entry.capabilities['reasoning']).toEqual(REPORTED);
    await gateway.close();
  });

  it('a reasoning control the user declares wins over the reported one, and so does a saved effort or models.effort over the reported default', async () => {
    const declared = { contextWindow: 128000, maxOutputTokens: 16000, reasoning: { control: 'reasoning_effort', lowest: 'none' } };
    const own = await started({ models: [PLAN_MODEL], declaredCapabilities: declared, targetExtra: { entry: { effort: 'low' } } });
    const ownEntry = await listed(own);
    expect(ownEntry.capabilities['reasoning']).toEqual({ control: 'reasoning_effort', lowest: 'none' });
    expect(ownEntry.effort).toBe('low');
    await own.close();
    const every = await started({ models: [PLAN_MODEL], declaredCapabilities: false, modelsRest: { effort: 'medium' } });
    expect((await listed(every)).effort).toBe('medium');
    await every.close();
  });

  it('an entry that reports no level leaves reasoning absent and lists no effort', async () => {
    const { supported_reasoning_levels: _levels, default_reasoning_level: _default, ...silent } = PLAN_MODEL;
    const gateway = await started({ models: [silent], declaredCapabilities: false });
    const entry = await listed(gateway);
    expect(entry.capabilities).not.toHaveProperty('reasoning');
    expect(entry).not.toHaveProperty('effort');
    await gateway.close();
  });
});
