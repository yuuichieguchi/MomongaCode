import { canonicalJson, createUdsClient } from '@momonga/foundation';
import { countReplyOf } from '@momonga/protocol';
import type {
  AdapterTarget,
  Capabilities,
  CountTokensRequest,
  CountTokensResult,
  HealthResult,
  InputItem,
  OutputBoundField,
  ProbeReport,
  ToolCallingMode,
  ToolCallingSetting,
  ToolCallingState,
} from '@momonga/protocol';
import type { ChatCompletionsEndpoint } from '../adapters/chat-completions/types.ts';
import { matchesGuardrailCode } from '../adapters/chat-completions/classify.ts';
import { FM_VOCABULARY } from '../adapters/chat-completions/vocabulary.ts';
import type { ErrorVocabulary } from '../adapters/shared/vocabulary.ts';
import { estimatedCountOf } from '../core/estimate.ts';
import { capabilitiesFromProbe, layerOf, mergeCapabilities } from '../probe/decide.ts';
import type { KeywordSupport } from '../probe/envelope.ts';
import { field, firstOf, parseJson } from '../probe/json.ts';
import { isUnprobedAuto, loadProbeRecord, resolveToolCalling } from '../probe/record.ts';
import { needsProbeOf } from '../probe/remedy.ts';
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
  declaredModel?: string;
  declaredOutputBoundField?: OutputBoundField;
};

export type ManagedFmTarget = {
  resolveEndpoint: (target: AdapterTarget) => Promise<ChatCompletionsEndpoint>;
  toolCalling: (target: AdapterTarget) => ToolCallingMode;
  keywordSupport: (target: AdapterTarget) => KeywordSupport;
  upstreamModel: (target: AdapterTarget, signal: AbortSignal) => Promise<string>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  countTokens: (target: AdapterTarget, request: CountTokensRequest, signal: AbortSignal) => Promise<CountTokensResult>;
  health: (target: AdapterTarget) => Promise<HealthResult>;
  isGuardrail: (target: AdapterTarget, status: number, body: unknown) => boolean;
  vocabulary: ErrorVocabulary;
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

const unprobedCapabilities = (mode: ToolCallingState): Capabilities => ({
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
  const calibrated = counted === 0 ? 0 : Math.ceil(counted * calibration.ratio - CEIL_TOLERANCE);
  return countReplyOf(calibrated, 'calibrated', { ratio: calibration.errorBound, minimum: 1 });
};

const errorOf = (body: unknown): Record<string, unknown> | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
};

const nonEmptyString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const BARE_STATUS_CODE = /^\d{3}$/;
const GENERIC_ERROR_CODES: ReadonlySet<string> = new Set(['invalid_request_error', 'invalid_request', 'bad_request', 'server_error', 'internal_error', 'error']);

const isGenericCode = (code: string): boolean => BARE_STATUS_CODE.test(code) || GENERIC_ERROR_CODES.has(code);

const guardrailMatcherOf = (report: ProbeReport | null): ((body: unknown) => boolean) => {
  const shape = errorOf(report?.guardrail.errorShape);
  const code = nonEmptyString(shape?.['code']);
  const message = nonEmptyString(shape?.['message']);
  const type = nonEmptyString(shape?.['type']);
  if (code === undefined || (message === undefined && isGenericCode(code))) return matchesGuardrailCode;
  return (body) => {
    const error = errorOf(body);
    return (
      error?.['code'] === code &&
      (message === undefined || error?.['message'] === message) &&
      (type === undefined || error?.['type'] === type)
    );
  };
};

const listedModelId = async (socketPath: string, signal: AbortSignal): Promise<string> => {
  const client = createUdsClient(socketPath);
  try {
    const response = await client.request({ method: 'GET', path: '/v1/models', signal });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`fm serve answered GET /v1/models with HTTP ${response.status}: ${text.slice(0, 200)}`);
    const id = field(firstOf(field(parseJson(text), 'data')), 'id');
    if (typeof id !== 'string') throw new Error('fm serve lists no model id at GET /v1/models');
    return id;
  } finally {
    await client.close();
  }
};

export const createManagedFmTarget = async (options: ManagedFmTargetOptions): Promise<ManagedFmTarget> => {
  const report = await loadProbeRecord(options.probeRecordDir, options.recordKey);
  const { target: targetName, binarySha256, osBuild } = options.recordKey;
  const needsProbe = needsProbeOf(
    targetName,
    `the target "${targetName}" sets toolCalling to auto, but no probe record exists`,
    `no record for the fm binary with sha256 ${binarySha256} on OS build ${osBuild}`,
  );
  const toolCalling = (): ToolCallingMode => resolveToolCalling(options.toolCallingSetting, report, needsProbe).mode;
  const unprobedAuto = isUnprobedAuto(options.toolCallingSetting, report);
  const state = unprobedAuto ? 'needs_probe' : toolCalling();
  const { parallelToolCalls: _unprobedParallel, ...probedDefaults } = unprobedCapabilities(state);
  const declaredField = options.declaredOutputBoundField === undefined ? {} : { outputBoundField: options.declaredOutputBoundField };
  const capabilities =
    report === null
      ? { ...unprobedCapabilities(state), ...(unprobedAuto ? { needsProbe } : {}), ...declaredField }
      : mergeCapabilities({ defaults: layerOf(probedDefaults).core, declared: declaredField, probed: layerOf(capabilitiesFromProbe(report, { mode: toolCalling() })).layer, probedAt: report.probedAt });
  const keywordSupport = report === null ? UNPROBED_KEYWORD_SUPPORT : report.keywordSupport;
  const isGuardrail = guardrailMatcherOf(report);
  const knownModel = options.declaredModel ?? report?.modelId;
  let listedModel: Promise<string> | undefined;
  const upstreamModel = async (_target: AdapterTarget, signal: AbortSignal): Promise<string> => {
    if (knownModel !== undefined) return knownModel;
    const { socketPath } = await options.fmServe.ensureRunning();
    listedModel ??= listedModelId(socketPath, signal).catch((error: unknown) => {
      listedModel = undefined;
      throw error;
    });
    return listedModel;
  };

  return {
    resolveEndpoint: () => options.fmServe.ensureRunning(),
    toolCalling,
    keywordSupport: () => keywordSupport,
    upstreamModel,
    capabilities: async () => capabilities,
    countTokens: async (_target, request, signal) => {
      const text = countedText(request);
      if (text === '') return countResultOf(0, report);
      const result = await options.exec(options.binary, ['count-tokens', '-q'], text, signal);
      return countResultOf(parseCount(result), report);
    },
    health: () => options.fmServe.health(),
    isGuardrail: (_target, _status, body) => isGuardrail(body),
    vocabulary: FM_VOCABULARY,
    close: () => options.fmServe.stop(),
  };
};
