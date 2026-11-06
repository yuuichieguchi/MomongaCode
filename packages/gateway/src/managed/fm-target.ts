import { canonicalJson, createUdsClient } from '@momonga/foundation';
import { countReplyOf } from '@momonga/protocol';
import type { AllowedToolsForm } from '@momonga/protocol';
import type {
  AdapterTarget,
  Capabilities,
  ConstructSupport,
  CountTokensRequest,
  DialectId,
  CountTokensResult,
  HealthResult,
  InputItem,
  NeedsProbe,
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
import type { CapabilityLayer } from '../probe/decide.ts';
import { NO_USER_DIALECTS } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import { FULL_KEYWORD_SUPPORT } from '../dialect/keyword-support.ts';
import type { KeywordSupport } from '../dialect/keyword-support.ts';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import type { EnvelopeShape } from '../probe/envelope.ts';
import { PROBE_METHOD_VERSION } from '../probe/run-probe.ts';
import { field, firstOf, parseJson } from '../probe/json.ts';
import { isUnprobedAuto, loadProbeRecord, resolveToolCalling } from '../probe/record.ts';
import { declaredDialectRefusal, needsProbeOf } from '../probe/remedy.ts';
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

export type UnmeasuredRecordKey = { target: string; unmeasured: string };

export type ManagedFmTargetOptions = {
  fmServe: FmServe;
  binary: string;
  exec: ExecWithStdinFn;
  probeRecordDir: string;
  recordKey: ProbeRecordKey | UnmeasuredRecordKey;
  toolCallingSetting: ToolCallingSetting;
  declaredModel?: string;
  declaredOutputBoundField?: OutputBoundField;
  declaredDialect?: DialectId;
  userDialects?: UserDialects;
};

export type ManagedFmTarget = {
  resolveEndpoint: (target: AdapterTarget) => Promise<ChatCompletionsEndpoint>;
  keywordSupport: (target: AdapterTarget) => KeywordSupport;
  schemaDialect: (target: AdapterTarget) => DialectId;
  constructSupport: (target: AdapterTarget) => ConstructSupport | undefined;
  envelopeShape: (target: AdapterTarget) => EnvelopeShape;
  upstreamModel: (target: AdapterTarget, signal: AbortSignal) => Promise<string>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  countTokens: (target: AdapterTarget, request: CountTokensRequest, signal: AbortSignal) => Promise<CountTokensResult>;
  health: (target: AdapterTarget) => Promise<HealthResult>;
  isGuardrail: (target: AdapterTarget, status: number, body: unknown) => boolean;
  vocabulary: ErrorVocabulary;
  close: () => Promise<void>;
};

const FM_ALLOWED_TOOLS: readonly AllowedToolsForm[] = ['envelope'];

const CEIL_TOLERANCE = 1e-9;
const UNPROBED_CONTEXT_WINDOW = 4096;
const UNPROBED_MAX_OUTPUT_TOKENS = 1024;

const unprobedCapabilities = (mode: ToolCallingState, schemaDialect: DialectId): Capabilities => ({
  contextWindow: UNPROBED_CONTEXT_WINDOW,
  maxOutputTokens: UNPROBED_MAX_OUTPUT_TOKENS,
  toolCalling: mode,
  structuredOutput: mode === 'constrained' ? 'json_schema' : 'none',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect,
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

const probedLayerOf = (report: ProbeReport, refusal: NeedsProbe | undefined, modeOf: () => ToolCallingMode): CapabilityLayer => {
  const layer = layerOf(capabilitiesFromProbe(report, { mode: refusal === undefined ? modeOf() : 'none' })).layer;
  return refusal === undefined ? layer : { ...layer, toolCalling: refusal };
};

export const createManagedFmTarget = async (options: ManagedFmTargetOptions): Promise<ManagedFmTarget> => {
  const { recordKey } = options;
  const identityText =
    'unmeasured' in recordKey
      ? `the fm binary, whose identity could not be measured (${recordKey.unmeasured})`
      : `the fm binary with sha256 ${recordKey.binarySha256} on OS build ${recordKey.osBuild}`;
  const report = 'unmeasured' in recordKey ? null : await loadProbeRecord(options.probeRecordDir, recordKey, {
    userDialects: options.userDialects ?? NO_USER_DIALECTS,
    probeMethod: PROBE_METHOD_VERSION,
    ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
  });
  const schemaDialect = resolveDialectId(options.declaredDialect, report);
  const targetName = recordKey.target;
  const needsProbe = needsProbeOf(
    targetName,
    `the target "${targetName}" sets toolCalling to auto, but no probe record exists`,
    `no record for ${identityText}`,
  );
  const modeOf = (): ToolCallingMode => resolveToolCalling(options.toolCallingSetting, report, needsProbe).mode;
  const unprobedAuto = isUnprobedAuto(options.toolCallingSetting, report);
  const refusedDeclaration =
    options.toolCallingSetting === 'auto' && report !== null
      ? declaredDialectRefusal(targetName, options.declaredDialect, report.schemaDialect, identityText)
      : undefined;
  const state = unprobedAuto ? needsProbe : (refusedDeclaration ?? modeOf());
  const { parallelToolCalls: _unprobedParallel, ...probedDefaults } = unprobedCapabilities(state, schemaDialect);
  const declaredField = options.declaredOutputBoundField === undefined ? {} : { outputBoundField: options.declaredOutputBoundField };
  const capabilities =
    report === null
      ? { ...unprobedCapabilities(state, schemaDialect), ...declaredField }
      : mergeCapabilities({
          defaults: layerOf(probedDefaults).core,
          declared: { ...declaredField, schemaDialect },
          probed: probedLayerOf(report, refusedDeclaration, modeOf),
          probedAt: report.probedAt,
        });
  const keywordSupport = report?.keywordSupport ?? FULL_KEYWORD_SUPPORT;
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
    keywordSupport: () => keywordSupport,
    schemaDialect: () => capabilities.schemaDialect,
    constructSupport: () => report?.constructSupport,
    envelopeShape: () => report?.schemaDialect.shape ?? 'union',
    upstreamModel,
    capabilities: async () => ({ ...capabilities, allowedTools: FM_ALLOWED_TOOLS }),
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
