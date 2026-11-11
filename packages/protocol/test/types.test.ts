import { describe, expectTypeOf, it } from 'vitest';
import type {
  AdapterSampling,
  ConstructSupport,
  DialectId,
  Capabilities,
  ProviderAdapter,
  HealthResult,
  ProbeKeyword,
  ProbeReport,
  RunHealth,
  ToolCallingMode,
  ToolCallingSetting,
  Unavailable,
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
        toolCalling: ToolCallingMode | { state: 'needs_probe'; message: string; evidence: string; remedy: string } | { state: 'probing'; message: string; retryAfterSeconds: number } | Unavailable;
        structuredOutput: 'json_schema' | 'none';
        jsonMode?: 'json_object' | 'none';
        streaming: boolean;
        stopSequences: boolean;
        outputBoundField?: 'max_completion_tokens' | 'max_tokens' | 'max_output_tokens' | 'none';
        systemRole?: 'system' | 'developer';
        toolPlacement?: 'top_level' | 'additional_tools';
        inputKinds?: {
          content: readonly ('file' | 'audio' | 'video')[];
          tools: readonly ('function' | 'custom' | 'programmatic_tool_calling' | 'image_generation' | 'file_search' | 'code_interpreter' | 'computer_use' | 'mcp' | 'tool_search')[];
        };
        parallelToolCalls?: boolean;
        allowedTools?: readonly ('native' | 'envelope' | 'single_tool' | 'filter')[];
        idempotencyKey?: { header: string };
        schemaDialect: DialectId;
        tokenCounting: 'exact' | 'calibrated' | 'estimated';
        tokenErrorRatio?: number;
        usageReported: boolean;
        maxConcurrency: number;
        source: 'declared' | 'probed' | 'config' | 'unprobed';
        probedAt?: string;
        sampling?: { accepts: 'none' } | { accepts: 'without_thinking'; topP: { min: number; max: number } } | { accepts: 'free' };
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

  it('requires every adapter to declare the sampling fields it renders', () => {
    expectTypeOf<ProviderAdapter['sampling']>().toEqualTypeOf<AdapterSampling>();
    expectTypeOf<ReturnType<ProviderAdapter['capabilities']>>().toEqualTypeOf<Promise<Capabilities>>();
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
      reason?: 'not_running' | 'unhealthy' | 'precondition_failed' | 'health_check_failed' | 'sign_in_required' | 'store_unreadable' | 'store_unwritable' | 'capabilities_unknown';
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
      keywordSupport?: Record<ProbeKeyword, boolean>;
      constructSupport?: ConstructSupport;
      schemaDialect: { selected: string | null; shape: 'union' | 'flat' | null; tried: { id: string; result: 'accepted' | 'refused' | 'not-enforced' | 'unrenderable'; detail?: string }[] };
      stopSequences: boolean;
      outputBoundField?: 'max_completion_tokens' | 'max_tokens' | 'none';
      parallelToolCalls?: { accepted: boolean; multiCallRate: number };
      reasoning?: { control: 'none'; headroomTokens?: number } | { control: 'reasoning_effort'; lowest: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' };
      maxConcurrency?: { value: number; evidence: 'refused' };
      imageInputAccepted: boolean;
      imageTokens?: { pixelsPerToken: number; maxTokens: number; minTokens: number };
      guardrail: { errorShape?: unknown };
      tokenCalibration?: { ratio: number; errorBound: number };
      promptCache?: { kind: 'automatic' | 'none' };
      jsonMode?: 'accepted' | 'refused' | 'unmeasured';
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
      state: 'running' | 'retiring' | 'draining';
      role: 'starting' | 'serving' | 'retiring';
      steps: number;
      jobs: number;
      sandbox: 'seatbelt' | 'bubblewrap' | 'none';
    }>();
  });
});
