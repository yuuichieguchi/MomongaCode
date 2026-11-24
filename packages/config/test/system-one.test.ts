import { describe, expect, it } from 'vitest';
import {
  ADAPTERS,
  SETTINGS_SCHEMA,
  planModelsEdit,
  resolveModels,
  serverRegistryOf,
} from '../src/index.ts';
import type { ModelConnection, ModelsSettings } from '../src/index.ts';
import { defineProductSchema } from '@momonga/foundation';
import { SERVER_KINDS } from '@momonga/protocol';

const validateSettings = defineProductSchema<Record<string, unknown>>('test/system-one-settings', SETTINGS_SCHEMA);

const textConnection = (): ModelConnection => ({
  adapter: 'open-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  models: [{ id: 'gpt-5', capabilities: { contextWindow: 128_000, maxOutputTokens: 16_384 } }],
});

const systemOneConnection = (extra: Record<string, unknown> = {}): ModelConnection =>
  ({
    adapter: 'system-one',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [{ id: 'typesafe/jev-1.14', capabilities: { contextWindow: 262_144 } }],
    ...extra,
  }) as unknown as ModelConnection;

const resolve = (models: ModelsSettings, opts: { classifier?: string; memoryReviewModel?: string } = {}) =>
  resolveModels(models, {
    source: 'settings.json',
    warnings: [],
    servers: serverRegistryOf(undefined, 'settings.json'),
    ...opts,
  });

describe('system-one adapter traits & schema', () => {
  it('registers system-one as choice-only, url-only, non-listable, key-optional', () => {
    const traits = ADAPTERS['system-one'];
    expect(traits.outputKind).toBe('choice');
    expect(traits.address).toBe('url');
    expect(traits.serverListable).toBe(false);
    expect(traits.credentials).toBe('key');
    expect(traits.probe).toBe('none');
  });

  it('accepts minimal system-one connection with baseUrl and contextWindow (with or without key)', () => {
    expect(validateSettings({ models: { connections: [systemOneConnection()] } }).valid).toBe(true);
    expect(validateSettings({ models: { connections: [systemOneConnection({ apiKeyEnv: 'OPENROUTER_API_KEY' })] } }).valid).toBe(true);
  });

  it('requires baseUrl with exact schema message (J34-A)', () => {
    const res = validateSettings({
      models: { connections: [{ adapter: 'system-one', models: [{ id: 'typesafe/jev-1.14', capabilities: { contextWindow: 262_144 } }] }] },
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.map((e) => e.message).join(' ')).toContain("must have required property 'baseUrl'");
  });

  it('rejects socketPath, answers, idempotencyKeyHeader, effort, toolCalling, maxOutputTokens (J29-A, J30-A, J31-A)', () => {
    const bads = [
      systemOneConnection({ socketPath: '/tmp/s.sock' }),
      systemOneConnection({ answers: 'model' }),
      systemOneConnection({ idempotencyKeyHeader: 'X-Idempotency-Key' }),
      {
        adapter: 'system-one',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ id: 'typesafe/jev-1.14', effort: 'low', capabilities: { contextWindow: 262_144 } }],
      },
      {
        adapter: 'system-one',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ id: 'typesafe/jev-1.14', toolCalling: 'none', capabilities: { contextWindow: 262_144 } }],
      },
      {
        adapter: 'system-one',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ id: 'typesafe/jev-1.14', capabilities: { contextWindow: 262_144, maxOutputTokens: 256 } }],
      },
    ];
    for (const conn of bads) {
      const res = validateSettings({ models: { connections: [conn] } });
      expect(res.valid).toBe(false);
    }
  });
});

describe('resolveModels with choice-only models', () => {
  it('defaults start to first text model, or undefined when only choice models exist (J9-A, Plan 1.1 #4)', () => {
    const both = resolve({ connections: [systemOneConnection(), textConnection()] });
    expect(both.start).toBe('openai/gpt-5');

    const onlyChoice = resolve({ connections: [systemOneConnection()] });
    expect(onlyChoice.start).toBeUndefined();
  });

  it('does not attach fallback models to choice-only models (J21-A) and sets maxOutputTokens=256 (J28-B)', () => {
    const resolved = resolve({
      connections: [textConnection(), systemOneConnection()],
      fallback: ['openai/gpt-5'],
    });
    const jevCanon = 'srv-openrouter.ai-443/typesafe/jev-1.14';
    expect(resolved.chains.get(jevCanon)).toEqual([jevCanon]);
    const jev = resolved.models.get(jevCanon);
    expect(jev?.outputKind).toBe('choice');
    expect(jev?.capabilities?.maxOutputTokens).toBe(256);
    expect(jev?.capabilities !== undefined && 'outputBoundField' in jev.capabilities ? jev.capabilities.outputBoundField : undefined).toBe('none');
  });

  it('rejects choice-only model for start, fallback, roles, and billingChanges (J5-A, J8-1, J20-B)', () => {
    const base = { connections: [textConnection(), systemOneConnection()] };
    expect(() => resolve({ ...base, start: 'typesafe/jev-1.14' })).toThrow('typesafe/jev-1.14 only judges approvals; it cannot be the model for new sessions.');
    expect(() => resolve({ ...base, fallback: ['typesafe/jev-1.14'] })).toThrow('typesafe/jev-1.14 only judges approvals; it cannot be the model for fallback.');
    expect(() => resolve({ ...base, roles: { compaction: 'typesafe/jev-1.14' } })).toThrow('typesafe/jev-1.14 only judges approvals; it cannot be the model for summaries.');
    expect(() => resolve({ ...base, roles: { reflection: 'typesafe/jev-1.14' } })).toThrow('typesafe/jev-1.14 only judges approvals; it cannot be the model for reflection.');
    expect(() => resolve({ ...base, roles: { analysis: 'typesafe/jev-1.14' } })).toThrow('typesafe/jev-1.14 only judges approvals; it cannot be the model for analysis.');
    expect(() => resolve({ ...base, roles: { subagent: 'typesafe/jev-1.14' } })).toThrow('typesafe/jev-1.14 only judges approvals; it cannot be the model for subagents.');
    expect(() => resolve({ ...base, billingChanges: [{ from: 'local', to: 'metered', model: 'typesafe/jev-1.14' }] })).toThrow(
      'typesafe/jev-1.14 only judges approvals; it cannot be the model for a billing rule.',
    );
  });

  it('accepts choice-only model for autoMode.classifier and memory.autoReviewModel', () => {
    const resolved = resolve(
      { connections: [textConnection(), systemOneConnection()] },
      { classifier: 'typesafe/jev-1.14', memoryReviewModel: 'typesafe/jev-1.14' },
    );
    expect(resolved.classifier).toBe('srv-openrouter.ai-443/typesafe/jev-1.14');
    expect(resolved.memoryReviewModel).toBe('srv-openrouter.ai-443/typesafe/jev-1.14');
  });

  it('refuses writing a choice-only model to start/fallback/roles/billing via planModelsEdit', () => {
    const settings = { models: { connections: [textConnection(), systemOneConnection()] } };
    const jevCanon = 'srv-openrouter.ai-443/typesafe/jev-1.14';
    const startPlan = planModelsEdit(settings, [{ kind: 'setStart', model: jevCanon }], { kinds: SERVER_KINDS });
    expect('refused' in startPlan ? startPlan.refused.message : '').toContain(
      'typesafe/jev-1.14 only judges approvals; it cannot be the model for new sessions.',
    );
    const clsPlan = planModelsEdit(settings, [{ kind: 'setClassifier', model: jevCanon }], { kinds: SERVER_KINDS });
    expect('refused' in clsPlan).toBe(false);
    const memPlan = planModelsEdit(settings, [{ kind: 'setMemoryReviewModel', model: jevCanon }], { kinds: SERVER_KINDS });
    expect('refused' in memPlan).toBe(false);
  });
});
