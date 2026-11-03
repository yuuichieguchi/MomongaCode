import { canonicalJson } from '@momonga/foundation';
import { errorBoundOfShape } from '@momonga/protocol';
import type {
  AdapterTarget,
  Capabilities,
  CountTokensRequest,
  CountTokensResult,
  HealthResult,
  InputItem,
  ProbeReport,
  ToolCallingMode,
  ToolCallingSetting,
} from '@momonga/protocol';
import type { ChatCompletionsEndpoint } from '../adapters/chat-completions/types.ts';
import { matchesGuardrailCode } from '../adapters/chat-completions/classify.ts';
import { estimatedCountOf } from '../core/estimate.ts';
import { capabilitiesFromProbe } from '../probe/decide.ts';
import type { KeywordSupport } from '../probe/envelope.ts';
import { loadProbeRecord, resolveToolCalling } from '../probe/record.ts';
import type { ProbeRecordKey } from '../probe/record.ts';
import { LICENSE_NOT_ACCEPTED_EXIT_CODE, LICENSE_REMEDIATION, PRECONDITION_MESSAGE, outputOf } from './fm-serve.ts';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import type { ExecResult, FmServe } from './fm-serve.ts';

export type ExecWithStdinFn = (
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
) => Promise<ExecResult>;

export type ManagedFmTargetOptions = {
  fmServe: FmServe;
  binary: string;
  exec: ExecWithStdinFn;
  probeRecordDir: string;
  recordKey: ProbeRecordKey;
  toolCallingSetting: ToolCallingSetting;
};

export type ManagedFmTarget = {
  resolveEndpoint: (target: AdapterTarget) => Promise<ChatCompletionsEndpoint>;
  toolCalling: (target: AdapterTarget) => ToolCallingMode;
  keywordSupport: (target: AdapterTarget) => KeywordSupport;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  countTokens: (target: AdapterTarget, request: CountTokensRequest, signal: AbortSignal) => Promise<CountTokensResult>;
  health: (target: AdapterTarget) => Promise<HealthResult>;
  isGuardrail: (target: AdapterTarget, status: number, body: unknown) => boolean;
  close: () => Promise<void>;
};

const UNPROBED_KEYWORD_SUPPORT: KeywordSupport = {
  enum: true,
  anyOf: true,
  const: true,
  pattern: true,
  minimum: true,
  nested: true,
  additionalProperties: true,
};

const CEIL_TOLERANCE = 1e-9;
const UNPROBED_CONTEXT_WINDOW = 4096;
const UNPROBED_MAX_OUTPUT_TOKENS = 1024;

const unprobedCapabilities = (mode: ToolCallingMode): Capabilities => ({
  contextWindow: UNPROBED_CONTEXT_WINDOW,
  maxOutputTokens: UNPROBED_MAX_OUTPUT_TOKENS,
  toolCalling: mode,
  structuredOutput: mode === 'constrained' ? 'json_schema' : 'none',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: false,
  maxConcurrency: 1,
  source: 'unprobed',
});

const textOfOutput = (output: Extract<InputItem, { type: 'function_call_output' }>['output']): string =>
  typeof output === 'string'
    ? output
    : output.map((part) => ('text' in part ? part.text : part.type === 'refusal' ? part.refusal : '')).join('\n');

const textOfItem = (item: InputItem): string => {
  switch (item.type) {
    case 'message':
      return typeof item.content === 'string' ? item.content : textOfOutput(item.content);
    case 'function_call':
      return `${item.name} ${item.arguments}`;
    case 'function_call_output':
      return textOfOutput(item.output);
    case 'reasoning':
    case 'compaction':
      return '';
  }
};

const countedText = (request: CountTokensRequest): string => {
  const items = typeof request.input === 'string' ? [request.input] : request.input.map(textOfItem);
  const tools = (request.tools ?? []).map((tool) =>
    canonicalJson({ name: tool.name, description: tool.description ?? null, parameters: tool.parameters ?? null }),
  );
  return [...(request.instructions === undefined || request.instructions === null ? [] : [request.instructions]), ...tools, ...items]
    .filter((part) => part !== '')
    .join('\n');
};

export const parseCount = (result: ExecResult): number => {
  if (result.exitCode === LICENSE_NOT_ACCEPTED_EXIT_CODE) {
    throw new PreconditionFailedError(PRECONDITION_MESSAGE, outputOf(result), LICENSE_REMEDIATION);
  }
  if (result.exitCode !== 0) {
    throw new Error(`fm count-tokens failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
  }
  const text = result.stdout.trim();
  if (!/^\d+$/.test(text)) throw new Error(`fm count-tokens printed an unexpected value: ${JSON.stringify(text.slice(0, 80))}`);
  return Number(text);
};

const countResultOf = (counted: number, report: ProbeReport | null): CountTokensResult => {
  const calibration = report?.tokenCalibration;
  if (calibration === undefined) {
    return estimatedCountOf(counted);
  }
  const calibrated = Math.ceil(counted * calibration.ratio - CEIL_TOLERANCE);
  const shape = { ratio: calibration.errorBound, minimum: 1 };
  return {
    input_tokens: calibrated,
    method: 'calibrated',
    error_bound: errorBoundOfShape(shape, calibrated),
    error_shape: shape,
  };
};

const errorOf = (body: unknown): Record<string, unknown> | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
};

const nonEmptyString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const guardrailMatcherOf = (report: ProbeReport | null): ((body: unknown) => boolean) => {
  const shape = errorOf(report?.guardrail.errorShape);
  const code = nonEmptyString(shape?.['code']);
  if (code !== undefined) return (body) => errorOf(body)?.['code'] === code;
  return matchesGuardrailCode;
};

export const createManagedFmTarget = async (options: ManagedFmTargetOptions): Promise<ManagedFmTarget> => {
  const report = await loadProbeRecord(options.probeRecordDir, options.recordKey);
  const { mode } = resolveToolCalling(options.toolCallingSetting, report);
  const capabilities = report === null ? unprobedCapabilities(mode) : capabilitiesFromProbe(report, { mode });
  const keywordSupport = report === null ? UNPROBED_KEYWORD_SUPPORT : report.keywordSupport;
  const isGuardrail = guardrailMatcherOf(report);

  return {
    resolveEndpoint: () => options.fmServe.ensureRunning(),
    toolCalling: () => mode,
    keywordSupport: () => keywordSupport,
    capabilities: async () => capabilities,
    countTokens: async (_target, request, signal) => {
      const result = await options.exec(options.binary, ['count-tokens', '-q'], countedText(request), signal);
      return countResultOf(parseCount(result), report);
    },
    health: () => options.fmServe.health(),
    isGuardrail: (_target, _status, body) => isGuardrail(body),
    close: () => options.fmServe.stop(),
  };
};
