import { describe, expect, it } from 'vitest';
import type { ResolvedChatCompletionsTarget, UserModels } from '@momonga/config';
import { liveSettingsFor } from '../src/eval/context-host.ts';

const capabilities = (structuredOutput: 'none' | 'json_schema') => ({
  contextWindow: 8192,
  maxOutputTokens: 1024,
  structuredOutput,
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
  maxConcurrency: 4,
});

const target = (model: string, structuredOutput: 'none' | 'json_schema'): ResolvedChatCompletionsTarget =>
  ({
    adapter: 'chat-completions',
    model,
    toolCalling: 'native',
    provider: 'p',
    baseUrl: 'http://127.0.0.1:8080/v1',
    billing: 'local',
    capabilities: capabilities(structuredOutput),
    maxConcurrency: 4,
    admissionTimeoutMs: 30000,
  }) as unknown as ResolvedChatCompletionsTarget;

const declared = (model: string) => ({ adapter: 'chat-completions', model, provider: 'p', baseUrl: 'http://127.0.0.1:8080/v1', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }) as const;

const userModels = (): UserModels =>
  ({
    declared: { aliases: { worker: ['w'], guard: ['g'], plain: ['n'] }, targets: { w: declared('worker-model'), g: declared('guard-model'), n: declared('plain-model') } },
    resolved: {
      aliases: { worker: ['w'], guard: ['g'], plain: ['n'] },
      targets: { w: target('worker-model', 'json_schema'), g: target('guard-model', 'json_schema'), n: target('plain-model', 'none') },
      dialects: {},
      roles: {},
    },
  }) as unknown as UserModels;

describe('liveSettingsFor takes a list of aliases (N1)', () => {
  it('returns the old output for one alias', () => {
    const settings = liveSettingsFor(userModels(), ['guard']);
    expect(settings.models).toEqual({ aliases: { guard: ['g'] }, targets: { g: declared('guard-model') } });
    expect(settings.credentials).toEqual([]);
    expect(settings.fmTargets).toEqual([]);
  });

  it('maps each listed alias to its members and unites their targets', () => {
    const settings = liveSettingsFor(userModels(), ['worker', 'guard']);
    expect(settings.models).toEqual({ aliases: { worker: ['w'], guard: ['g'] }, targets: { w: declared('worker-model'), g: declared('guard-model') } });
  });

  it('deduplicates when the agent and the classifier alias are equal', () => {
    const settings = liveSettingsFor(userModels(), ['guard', 'guard']);
    expect(settings.models).toEqual({ aliases: { guard: ['g'] }, targets: { g: declared('guard-model') } });
  });
});
