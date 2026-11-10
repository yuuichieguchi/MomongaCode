import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import type { UserModels } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { ContextHostError, liveSettingsFor } from '../src/eval/context-host.ts';

const GATE_SOCKET = '/tmp/gate-home/.momonga/run/gateway.sock';

const resolvedPlanTarget = {
  adapter: 'open-responses',
  model: 'plan-model',
  provider: 'chatgpt',
  baseUrl: 'https://chatgpt.invalid/backend-api/codex',
  plan: { profile: 'chatgpt', account: 'gate' },
  billing: 'plan',
  capabilities: { contextWindow: 272000, maxOutputTokens: 128000, imageInput: false, parallelToolCalls: false, schemaDialect: 'json-schema-2020-12', tokenCounting: 'estimated', usageReported: true, source: 'config', maxConcurrency: 4 },
  maxConcurrency: 4,
  admissionTimeoutMs: 30000,
};

const declaredPlanTarget = { adapter: 'open-responses', model: 'plan-model', plan: { profile: 'chatgpt', account: 'gate' } };

const planModels = (target: typeof resolvedPlanTarget | Record<string, unknown> = resolvedPlanTarget): UserModels =>
  ({
    declared: { aliases: { default: ['p'] }, targets: { p: declaredPlanTarget } },
    resolved: { aliases: { default: ['p'] }, targets: { p: target }, dialects: {}, roles: {}, billingChanges: [], headersTimeoutMs: 300_000, idleTimeoutMs: 300_000 },
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
    expect(target?.['capabilities']).not.toHaveProperty('maxConcurrency');
    expect(settings.credentials).toEqual([]);
  });

  it('the relayed settings pass the real settings schema', async (context) => {
    const settings = relayed(planModels());
    const home = withTempDir(context, { asHome: true });
    const file = momongaLayout(home).settingsFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ models: settings.models }), { mode: 0o600 });
    const loaded = await loadUserSettings({ home });
    const target = loaded.settings.models.targets['p'];
    if (target === undefined || !('capabilities' in target) || target.capabilities === undefined) throw new Error('the relayed target p was not loaded with capabilities');
    expect(target.capabilities.contextWindow).toBe(272000);
  });

  it('a plan target without a context window is refused with the exact text', () => {
    const { contextWindow: _contextWindow, ...capabilities } = resolvedPlanTarget.capabilities;
    const refused = (): unknown => relayed(planModels({ ...resolvedPlanTarget, capabilities }));
    expect(refused).toThrow(ContextHostError);
    expect(refused).toThrow(
      "the target p has no known context window or output limit, so a case home cannot be given it; read the account's models first with momonga models --catalog",
    );
  });
});
