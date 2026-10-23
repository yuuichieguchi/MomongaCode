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
    expectTypeOf<Capabilities>().toEqualTypeOf<{
      contextWindow: number;
      maxOutputTokens: number;
      toolCalling: ToolCallingMode;
      structuredOutput: 'json_schema' | 'none';
      streaming: boolean;
      stopSequences: boolean;
      imageInput: boolean;
      parallelToolCalls: boolean;
      schemaDialect: 'json-schema-2020-12' | 'fm-generation';
      tokenCounting: 'exact' | 'calibrated' | 'estimated';
      usageReported: boolean;
      maxConcurrency: number;
      source: 'declared' | 'probed' | 'config' | 'unprobed';
      probedAt?: string;
    }>();
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
      maxConcurrency: number;
      imageInputAccepted: boolean;
      guardrail: { errorShape?: unknown };
      tokenCalibration?: { ratio: number; errorBound: number };
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
      sandbox: 'seatbelt' | 'none';
    }>();
  });
});
