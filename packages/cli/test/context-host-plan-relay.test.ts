import { describe, expect, it } from 'vitest';
import type { UserModels } from '@momonga/config';
import { liveSettingsFor } from '../src/eval/context-host.ts';

const GATE_SOCKET = '/tmp/gate-home/.momonga/run/gateway.sock';

const resolvedPlanTarget = {
  adapter: 'open-responses',
  model: 'plan-model',
  baseUrl: 'https://chatgpt.invalid/backend-api/codex',
  plan: { profile: 'chatgpt', account: 'gate' },
  billing: 'plan',
  capabilities: { contextWindow: 272000, maxOutputTokens: 128000, imageInput: true, parallelToolCalls: false, schemaDialect: 'json-schema-2020-12', tokenCounting: 'estimated', usageReported: true, source: 'reported', maxConcurrency: 4 },
  maxConcurrency: 4,
  admissionTimeoutMs: 30000,
};

const declaredPlanTarget = { adapter: 'open-responses', model: 'plan-model', plan: { profile: 'chatgpt', account: 'gate' } };

const planModels = (): UserModels =>
  ({
    declared: { aliases: { default: ['p'] }, targets: { p: declaredPlanTarget } },
    resolved: { aliases: { default: ['p'] }, targets: { p: resolvedPlanTarget }, dialects: {}, roles: {}, billingChanges: [], headersTimeoutMs: 300_000, idleTimeoutMs: 300_000 },
  }) as unknown as UserModels;

const relayed = (models: UserModels) =>
  (liveSettingsFor as unknown as (user: UserModels, aliases: readonly string[], relay: { planRelaySocket: string }) => ReturnType<typeof liveSettingsFor>)(models, ['default'], { planRelaySocket: GATE_SOCKET });

describe('the eval relay of a plan target (P6.10)', () => {
  it('rewrites a plan target into an open-responses target through the gate home gateway socket, with the resolved capabilities and billing plan, and no plan', () => {
    const settings = relayed(planModels());
    const target = settings.models.targets?.['p'] as Record<string, unknown> | undefined;
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty('plan');
    expect(target).not.toHaveProperty('apiKeyEnv');
    expect(target).not.toHaveProperty('apiKeySecret');
    expect(target).toMatchObject({ adapter: 'open-responses', model: 'plan-model', socketPath: GATE_SOCKET, billing: 'plan' });
    expect(target?.['capabilities']).toMatchObject({ contextWindow: 272000, maxOutputTokens: 128000 });
    expect(settings.credentials).toEqual([]);
  });
});
