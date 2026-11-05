import { describe, expectTypeOf, it } from 'vitest';
import type {
  Capabilities,
  HealthResult,
  ProbeKeyword,
  ProbeReport,
  RunHealth,
  ToolCallingMode,
  ToolCallingSetting,
} from '@momonga/protocol';

describe('protocol capability types', () => {
  it('defines tool calling modes and settings', () => {
    expectTypeOf<ToolCallingMode>().toEqualTypeOf<'native' | 'constrained' | 'none'>();
    expectTypeOf<ToolCallingSetting>().toEqualTypeOf<'native' | 'constrained' | 'auto'>();
  });

  it('defines Capabilities', () => {
    expectTypeOf<Capabilities>().toEqualTypeOf<
      {
        promptCache?: { kind: 'breakpoints'; maxBreakpoints: number } | { kind: 'key' } | { kind: 'automatic' } | { kind: 'none' };
        contextWindow: number;
        maxOutputTokens: number;
        toolCalling: ToolCallingMode | { state: 'needs_probe'; message: string; evidence: string; remedy: string };
        structuredOutput: 'json_schema' | 'none';
        streaming: boolean;
        stopSequences: boolean;
        outputBoundField?: 'max_completion_tokens' | 'max_tokens';
        parallelToolCalls?: boolean;
        schemaDialect: 'json-schema-2020-12' | 'guided-generation';
        tokenCounting: 'exact' | 'calibrated' | 'estimated';
        tokenErrorRatio?: number;
        usageReported: boolean;
        maxConcurrency: number;
        source: 'declared' | 'probed' | 'config' | 'unprobed';
        probedAt?: string;
        reasoning?:
          | { control: 'none'; headroomTokens?: number }
          | { control: 'reasoning_effort'; lowest: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
          | { control: 'thinking'; form: 'adaptive'; efforts: readonly ('low' | 'medium' | 'high' | 'xhigh')[]; off?: 'disabled' | 'between_tools' }
          | { control: 'thinking'; form: 'budget'; budgets: Readonly<Partial<Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh', number>>>; off?: 'disabled' | 'between_tools' };
      } & (
        | { imageInput: false; imageTokens?: undefined }
        | { imageInput: true; imageTokens: { pixelsPerToken: number; maxTokens: number; minTokens: number } }
      )
    >();
  });

  it('cannot express needs_probe without its details', () => {
    expectTypeOf<{ state: 'needs_probe' }>().not.toExtend<Capabilities['toolCalling']>();
    expectTypeOf<'needs_probe'>().not.toExtend<Capabilities['toolCalling']>();
  });

  it('cannot express image input without a token model', () => {
    expectTypeOf<Extract<Capabilities, { imageInput: true; imageTokens?: undefined }>>().toBeNever();
    expectTypeOf<Capabilities['imageTokens']>().toEqualTypeOf<{ pixelsPerToken: number; maxTokens: number; minTokens: number } | undefined>();
  });

  it('defines HealthResult', () => {
    expectTypeOf<HealthResult>().toEqualTypeOf<{
      ok: boolean;
      reason?: 'not_running' | 'unhealthy' | 'precondition_failed' | 'health_check_failed';
      detail?: string;
      remediation?: string;
    }>();
  });

  it('defines ProbeReport', () => {
    expectTypeOf<ProbeKeyword>().toEqualTypeOf<
      'enum' | 'anyOf' | 'const' | 'pattern' | 'minimum' | 'nested' | 'additionalProperties'
    >();
    expectTypeOf<ProbeReport>().toEqualTypeOf<{
      probedAt: string;
      health: HealthResult;
      modelId: string;
      contextWindow: { value: number; method: 'reported' | 'searched'; overflowErrorShape?: unknown };
      streaming: { supported: boolean; doneSentinel: boolean; usageInStream: boolean };
      usageReported: boolean;
      nativeTools: { accepted: boolean; validRate: number; roundTripOk: boolean };
      constrained: { accepted: boolean; validRate: number };
      keywordSupport: Record<ProbeKeyword, boolean>;
      stopSequences: boolean;
      outputBoundField?: 'max_completion_tokens' | 'max_tokens' | 'none';
      parallelToolCalls?: { accepted: boolean; multiCallRate: number };
      reasoning?:
          | { control: 'none'; headroomTokens?: number }
          | { control: 'reasoning_effort'; lowest: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
          | { control: 'thinking'; form: 'adaptive'; efforts: readonly ('low' | 'medium' | 'high' | 'xhigh')[]; off?: 'disabled' | 'between_tools' }
          | { control: 'thinking'; form: 'budget'; budgets: Readonly<Partial<Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh', number>>>; off?: 'disabled' | 'between_tools' };
      maxConcurrency: number;
      imageInputAccepted: boolean;
      imageTokens?: { pixelsPerToken: number; maxTokens: number; minTokens: number };
      guardrail: { errorShape?: unknown };
      tokenCalibration?: { ratio: number; errorBound: number };
      promptCache?: { kind: 'automatic' | 'none' };
    }>();
  });
});

describe('run api types', () => {
  it('RunHealth spells the health body with its own literals', () => {
    expectTypeOf<RunHealth>().toEqualTypeOf<{
      status: 'ok';
      version: string;
      apiVersion: 1;
      pid: number;
      startedAt: string;
      state: 'running' | 'draining';
      sandbox: 'seatbelt' | 'bubblewrap' | 'none';
    }>();
  });
});
