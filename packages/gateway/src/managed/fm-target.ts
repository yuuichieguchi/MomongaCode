import { canonicalJson } from '@momonga/foundation';
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
import type { KeywordSupport } from '../dialect/keyword-support.ts';
import { FULL_KEYWORD_SUPPORT } from '../dialect/keyword-support.ts';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import type { EnvelopeShape } from '../probe/envelope.ts';
import { PROBE_METHOD_VERSION } from '../probe/run-probe.ts';
import { loadProbeRecord, resolveToolCalling } from '../probe/record.ts';
import { targetProbingError } from '../probe/auto-probe.ts';
import type { AutoProbe } from '../probe/auto-probe.ts';
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

export type ManagedFmTargetOptions = {
  fmServe: FmServe;
  binary: string;
  exec: ExecWithStdinFn;
  probeRecordDir: string;
  target: string;
  readRecordKey: () => Promise<ProbeRecordKey>;
  autoProbe: AutoProbe;
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

const recordedDefaults = (mode: ToolCallingState, schemaDialect: DialectId, measured: Pick<Capabilities, 'contextWindow' | 'maxOutputTokens'>): Capabilities => ({
  contextWindow: measured.contextWindow,
  maxOutputTokens: measured.maxOutputTokens,
  toolCalling: mode,
  structuredOutput: mode === 'constrained' ? 'json_schema' : 'none',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  schemaDialect,
  tokenCounting: 'estimated',
  usageReported: false,
  maxConcurrency: 1,
  source: 'probed',
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

const countResultOf = (counted: number, report: ProbeReport): CountTokensResult => {
  const calibration = report.tokenCalibration;
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

const guardrailMatcherOf = (report: ProbeReport): ((body: unknown) => boolean) => {
  const shape = errorOf(report.guardrail.errorShape);
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

const probedOf = (report: ProbeReport, refusal: NeedsProbe | undefined, modeOf: () => ToolCallingMode): { measured: Capabilities; layer: CapabilityLayer } => {
  const measured = capabilitiesFromProbe(report, { mode: refusal === undefined ? modeOf() : 'none' });
  const { layer } = layerOf(measured);
  return { measured, layer: refusal === undefined ? layer : { ...layer, toolCalling: refusal } };
};

type RecordedFm = {
  report: ProbeReport;
  capabilities: Capabilities;
  isGuardrail: (body: unknown) => boolean;
};

export const createManagedFmTarget = async (options: ManagedFmTargetOptions): Promise<ManagedFmTarget> => {
  const targetName = options.target;
  const currency = {
    userDialects: options.userDialects ?? NO_USER_DIALECTS,
    probeMethod: PROBE_METHOD_VERSION,
    ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
  };
  const declaredField = options.declaredOutputBoundField === undefined ? {} : { outputBoundField: options.declaredOutputBoundField };

  const recordedOf = (key: ProbeRecordKey, report: ProbeReport): RecordedFm => {
    const identityText = `the fm binary with sha256 ${key.binarySha256} on OS build ${key.osBuild}`;
    const needsProbe = needsProbeOf(targetName, `the target "${targetName}" sets toolCalling to auto, but no probe record exists`, `no record for ${identityText}`);
    const modeOf = (): ToolCallingMode => resolveToolCalling(options.toolCallingSetting, report, needsProbe).mode;
    const refusedDeclaration =
      options.toolCallingSetting === 'auto' ? declaredDialectRefusal(targetName, options.declaredDialect, report.schemaDialect, identityText) : undefined;
    const schemaDialect = resolveDialectId(options.declaredDialect, report);
    const probed = probedOf(report, refusedDeclaration, modeOf);
    const capabilities = mergeCapabilities({
      defaults: layerOf(recordedDefaults(refusedDeclaration ?? modeOf(), schemaDialect, probed.measured)).core,
      declared: { ...declaredField, schemaDialect },
      probed: probed.layer,
      probedAt: report.probedAt,
    });
    return { report, capabilities, isGuardrail: guardrailMatcherOf(report) };
  };

  let recorded: RecordedFm | undefined;
  const readRecorded = async (): Promise<RecordedFm> => {
    const key = await options.readRecordKey();
    const report = await loadProbeRecord(options.probeRecordDir, key, currency);
    if (report === null) {
      await options.autoProbe.start(key);
      throw targetProbingError();
    }
    recorded = recordedOf(key, report);
    return recorded;
  };
  const lastRecorded = (): RecordedFm => {
    if (recorded === undefined) throw new Error(`the probe record of the target "${targetName}" was read by no request yet`);
    return recorded;
  };

  return {
    resolveEndpoint: () => options.fmServe.ensureRunning(),
    keywordSupport: () => lastRecorded().report.keywordSupport ?? FULL_KEYWORD_SUPPORT,
    schemaDialect: () => lastRecorded().capabilities.schemaDialect,
    constructSupport: () => lastRecorded().report.constructSupport,
    envelopeShape: () => lastRecorded().report.schemaDialect.shape ?? 'union',
    upstreamModel: async () => options.declaredModel ?? lastRecorded().report.modelId,
    capabilities: async () => ({ ...(await readRecorded()).capabilities, allowedTools: FM_ALLOWED_TOOLS }),
    countTokens: async (_target, request, signal) => {
      const { report } = await readRecorded();
      const text = countedText(request);
      if (text === '') return countResultOf(0, report);
      const result = await options.exec(options.binary, ['count-tokens', '-q'], text, signal);
      return countResultOf(parseCount(result), report);
    },
    health: () => options.fmServe.health(),
    isGuardrail: (_target, _status, body) => lastRecorded().isGuardrail(body),
    vocabulary: FM_VOCABULARY,
    close: () => options.fmServe.stop(),
  };
};
