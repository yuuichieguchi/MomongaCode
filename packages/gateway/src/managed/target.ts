import { canonicalJson, createUdsClient, fixedSocket, probeKeyComponentLabel } from '@momonga/foundation';
import { countReplyOf } from '@momonga/protocol';
import type {
  AdapterStop,
  AliasRoomFacts,
  AdapterTarget,
  AllowedToolsForm,
  Capabilities,
  ConstructSupport,
  CountTokensRequest,
  CountTokensResult,
  DialectId,
  HealthResult,
  InputItem,
  ManagedServerDescription,
  NeedsProbe,
  OutputBoundField,
  ProbeReport,
  Probing,
  ToolCallingMode,
  ToolCallingSetting,
  ToolCallingState,
} from '@momonga/protocol';
import type { KnownProbeKey, ProbeKey } from '@momonga/config';
import type { ChatCompletionsEndpoint } from '../adapters/chat-completions/types.ts';
import { matchesGuardrailCode } from '../adapters/chat-completions/classify.ts';
import { vocabularyOf } from '../adapters/chat-completions/vocabulary.ts';
import type { ErrorVocabulary } from '../adapters/shared/vocabulary.ts';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import { estimatedCountOf } from '../core/estimate.ts';
import { capabilitiesFromProbe, layerOf, mergeCapabilities } from '../probe/decide.ts';
import type { CapabilityLayer } from '../probe/decide.ts';
import type { UserDialects } from '../dialect/choice.ts';
import type { KeywordSupport } from '../dialect/keyword-support.ts';
import { FULL_KEYWORD_SUPPORT } from '../dialect/keyword-support.ts';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import type { EnvelopeShape } from '../probe/envelope.ts';
import { valueAtPath, parseJson } from '../probe/json.ts';
import { loadProbeRecord, resolveToolCalling } from '../probe/record.ts';
import type { ManagedRecordCurrency } from '../probe/record.ts';
import { targetProbingError } from '../probe/auto-probe.ts';
import type { InstanceProbe } from '../probe/instance-probe.ts';
import { declaredDialectRefusal, needsProbeOf } from '../probe/remedy.ts';
import { missingExecutableVerdict, notReadyText } from './preconditions.ts';
import type { ExecResult } from './preconditions.ts';
import type { ManagedServer } from './server.ts';

export type ExecWithStdinFn = (file: string, args: readonly string[], stdin: string, signal: AbortSignal) => Promise<ExecResult>;

export type ManagedTargetOptions = {
  description: ManagedServerDescription;
  server: ManagedServer;
  binary: string;
  exec: ExecWithStdinFn;
  probeRecordDir: string;
  target: string;
  requestLimitMs: number;
  isUsableBinary: (binary: string) => Promise<boolean>;
  readKey: (signal: AbortSignal) => Promise<ProbeKey>;
  onInstanceEnd: () => void;
  startProbe: (key: KnownProbeKey) => Promise<Probing>;
  instanceProbe: (unknown: { component: string; reason: string }) => InstanceProbe<ProbeReport>;
  currency: ManagedRecordCurrency;
  declaredCapabilities?: { contextWindow: number; maxOutputTokens: number };
  toolCallingSetting: ToolCallingSetting;
  declaredModel?: string;
  declaredOutputBoundField?: OutputBoundField;
  declaredDialect?: DialectId;
  userDialects?: UserDialects;
};

export type ManagedTarget = {
  resolveEndpoint: (target: AdapterTarget, signal: AbortSignal) => Promise<ChatCompletionsEndpoint>;
  keywordSupport: (target: AdapterTarget) => KeywordSupport;
  schemaDialect: (target: AdapterTarget) => DialectId;
  constructSupport: (target: AdapterTarget) => ConstructSupport | undefined;
  envelopeShape: (target: AdapterTarget) => EnvelopeShape;
  upstreamModel: (target: AdapterTarget, signal: AbortSignal) => Promise<string>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  roomFacts: (target: AdapterTarget) => Promise<AliasRoomFacts>;
  countTokens?: (target: AdapterTarget, request: CountTokensRequest, signal: AbortSignal) => Promise<CountTokensResult>;
  health: (target: AdapterTarget) => Promise<HealthResult>;
  isGuardrail: (target: AdapterTarget, status: number, body: unknown) => boolean;
  vocabulary: ErrorVocabulary;
  close: (stop?: AdapterStop) => Promise<void>;
  childExited: () => void;
};

const CEIL_TOLERANCE = 1e-9;

const INTEGER_TEXT = /^\d+$/;

const recordedDefaultsOf = (description: ManagedServerDescription, mode: ToolCallingState, schemaDialect: DialectId, measured: Pick<Capabilities, 'contextWindow' | 'maxOutputTokens'>): Capabilities => ({
  contextWindow: measured.contextWindow,
  maxOutputTokens: measured.maxOutputTokens,
  toolCalling: mode,
  structuredOutput: mode === 'constrained' ? 'json_schema' : 'none',
  streaming: true,
  stopSequences: description.recordedDefaults.stopSequences,
  imageInput: description.recordedDefaults.imageInput,
  schemaDialect,
  tokenCounting: description.recordedDefaults.tokenCounting,
  usageReported: description.recordedDefaults.usageReported,
  maxConcurrency: description.recordedDefaults.maxConcurrency,
  source: 'probed',
});

const textOfOutput = (output: Extract<InputItem, { type: 'function_call_output' }>['output']): string =>
  typeof output === 'string' ? output : output.map((part) => ('text' in part ? part.text : part.type === 'refusal' ? part.refusal : '')).join('\n');

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
  const tools = (request.tools ?? []).map((tool) => canonicalJson({ name: tool.name, description: tool.description ?? null, parameters: tool.parameters ?? null }));
  return [...(request.instructions === undefined || request.instructions === null ? [] : [request.instructions]), ...tools, ...items].filter((part) => part !== '').join('\n');
};

export const parseCount = (target: string, result: ExecResult): number => {
  if (result.exitCode !== 0) throw new Error(`the target "${target}": the token counter failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
  const text = result.stdout.trim();
  if (!INTEGER_TEXT.test(text)) throw new Error(`the target "${target}": the token counter printed an unexpected value: ${JSON.stringify(text.slice(0, 80))}`);
  return Number(text);
};

const countResultOf = (counted: number, report: ProbeReport | null): CountTokensResult => {
  const calibration = report?.tokenCalibration;
  if (calibration === undefined) return estimatedCountOf(counted);
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
    return error?.['code'] === code && (message === undefined || error?.['message'] === message) && (type === undefined || error?.['type'] === type);
  };
};

const probedOf = (report: ProbeReport, refusal: NeedsProbe | undefined, modeOf: () => ToolCallingMode): { measured: Capabilities; layer: CapabilityLayer } => {
  const measured = capabilitiesFromProbe(report, { mode: refusal === undefined ? modeOf() : 'none' });
  const { layer } = layerOf(measured);
  return { measured, layer: refusal === undefined ? layer : { ...layer, toolCalling: refusal } };
};

type Recorded = { report: ProbeReport | null; capabilities: Capabilities; isGuardrail: (body: unknown) => boolean };

const keyText = (description: ManagedServerDescription, key: KnownProbeKey): string => {
  return description.identity.map((component) => `${probeKeyComponentLabel(component)} ${String(key.fields[component])}`).join(', ');
};

export const createManagedTarget = async (options: ManagedTargetOptions): Promise<ManagedTarget> => {
  const { description, target: targetName } = options;
  const allowedTools: readonly AllowedToolsForm[] = description.toolForms;
  const declaredField = options.declaredOutputBoundField === undefined ? {} : { outputBoundField: options.declaredOutputBoundField };
  const declaredBounds = options.declaredCapabilities;
  const declaredMode = options.toolCallingSetting === 'auto' ? undefined : options.toolCallingSetting;
  const declaredOnly: Recorded | undefined =
    declaredBounds === undefined || declaredMode === undefined
      ? undefined
      : {
          report: null,
          capabilities: { ...recordedDefaultsOf(description, declaredMode, resolveDialectId(options.declaredDialect, null), declaredBounds), ...declaredField, source: 'declared' },
          isGuardrail: matchesGuardrailCode,
        };

  const recordedOf = (identityText: string, report: ProbeReport): Recorded => {
    const needsProbe = needsProbeOf(targetName, `the target "${targetName}" sets toolCalling to auto, but no probe record exists`, `no probe record exists for ${identityText}`);
    const modeOf = (): ToolCallingMode => resolveToolCalling(options.toolCallingSetting, report, needsProbe).mode;
    const refusedDeclaration = options.toolCallingSetting === 'auto' ? declaredDialectRefusal(targetName, options.declaredDialect, report.schemaDialect, identityText) : undefined;
    const schemaDialect = resolveDialectId(options.declaredDialect, report);
    const probed = probedOf(report, refusedDeclaration, modeOf);
    const capabilities = mergeCapabilities({
      defaults: layerOf(recordedDefaultsOf(description, refusedDeclaration ?? modeOf(), schemaDialect, probed.measured)).core,
      declared: { ...declaredField, ...(declaredBounds ?? {}), schemaDialect },
      probed: probed.layer,
      probedAt: report.probedAt,
    });
    return { report, capabilities, isGuardrail: guardrailMatcherOf(report) };
  };

  const requestSignal = (): AbortSignal => AbortSignal.timeout(options.requestLimitMs);

  const checkBinary = async (): Promise<void> => {
    if (await options.isUsableBinary(options.binary)) return;
    const refusal = missingExecutableVerdict(targetName, options.binary);
    throw new PreconditionFailedError(notReadyText(targetName, refusal.message), refusal.detail, undefined);
  };

  let unknownProbe: { component: string; probe: InstanceProbe<ProbeReport> } | undefined;
  const instanceProbeFor = (component: string, reason: string): InstanceProbe<ProbeReport> => {
    if (unknownProbe === undefined || unknownProbe.component !== component) unknownProbe = { component, probe: options.instanceProbe({ component, reason }) };
    return unknownProbe.probe;
  };

  let recorded: Recorded | undefined;
  const readRecorded = async (): Promise<Recorded> => {
    await checkBinary();
    const key = await options.readKey(requestSignal());
    if (key.kind === 'unknown') {
      const ensured = await instanceProbeFor(key.component, key.reason).ensure();
      if (ensured.kind === 'probing') {
        if (declaredOnly !== undefined) return (recorded = declaredOnly);
        throw targetProbingError(ensured.probing);
      }
      recorded = recordedOf(`the target "${targetName}"`, ensured.report);
      return recorded;
    }
    const report = await loadProbeRecord(options.probeRecordDir, key, options.currency, targetName);
    if (report === null) {
      if (declaredOnly !== undefined) return (recorded = declaredOnly);
      throw targetProbingError(await options.startProbe(key));
    }
    recorded = recordedOf(`the probe key of the target "${targetName}" (${keyText(description, key)})`, report);
    return recorded;
  };
  const lastRecorded = (): Recorded => {
    if (recorded === undefined) throw new Error(`the probe record of the target "${targetName}" was read by no request yet`);
    return recorded;
  };

  const listedModelId = async (socketPath: string, signal: AbortSignal): Promise<string> => {
    const client = createUdsClient(fixedSocket(socketPath));
    try {
      const response = await client.request({ method: 'GET', path: description.models.listPath, signal });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`the target "${targetName}": the server answered GET ${description.models.listPath} with HTTP ${response.status}: ${text.slice(0, 200)}`);
      const id = valueAtPath(parseJson(text), description.models.idPath);
      if (typeof id !== 'string') throw new Error(`the target "${targetName}": the server lists no model id at GET ${description.models.listPath}`);
      return id;
    } finally {
      await client.close();
    }
  };

  let listedModel: Promise<string> | undefined;
  const upstreamModel = async (_target: AdapterTarget, signal: AbortSignal): Promise<string> => {
    const knownModel = options.declaredModel ?? lastRecorded().report?.modelId;
    if (knownModel !== undefined) return knownModel;
    const { socketPath } = await options.server.ensureRunning(signal);
    listedModel ??= listedModelId(socketPath, signal).catch((error: unknown) => {
      listedModel = undefined;
      throw error;
    });
    return listedModel;
  };

  const { tokenCount } = description;
  const vocabulary = vocabularyOf(description);

  return {
    resolveEndpoint: async (_target, signal) => {
      await checkBinary();
      return options.server.ensureRunning(signal);
    },
    keywordSupport: () => lastRecorded().report?.keywordSupport ?? FULL_KEYWORD_SUPPORT,
    schemaDialect: () => lastRecorded().capabilities.schemaDialect,
    constructSupport: () => lastRecorded().report?.constructSupport,
    envelopeShape: () => lastRecorded().report?.schemaDialect.shape ?? 'union',
    upstreamModel,
    capabilities: async () => ({ ...(await readRecorded()).capabilities, allowedTools }),
    roomFacts: async () => {
      const { report } = await readRecorded();
      return {
        outputBounded: (options.declaredOutputBoundField ?? report?.outputBoundField) !== 'none',
        contextWindow: declaredBounds?.contextWindow ?? report?.contextWindow.value,
        maxOutputTokens: declaredBounds?.maxOutputTokens,
      };
    },
    ...(tokenCount === 'estimated'
      ? {}
      : {
          countTokens: async (_target: AdapterTarget, request: CountTokensRequest, signal: AbortSignal) => {
            const { report } = await readRecorded();
            const text = countedText(request);
            if (text === '') return countResultOf(0, report);
            return countResultOf(parseCount(targetName, await options.exec(options.binary, tokenCount.argv, text, signal)), report);
          },
        }),
    health: async () => {
      if (!(await options.isUsableBinary(options.binary))) {
        const refusal = missingExecutableVerdict(targetName, options.binary);
        return { ok: false, reason: 'precondition_failed', detail: refusal.detail };
      }
      return options.server.health(requestSignal());
    },
    isGuardrail: (_target, _status, body) => lastRecorded().isGuardrail(body),
    vocabulary,
    childExited: () => {
      options.onInstanceEnd();
      unknownProbe?.probe.restarted();
    },
    close: async (stop) => {
      await Promise.all([options.server.stop(stop === undefined ? undefined : { stopGraceMs: stop.managedServerStopGraceMs }), unknownProbe?.probe.close()]);
    },
  };
};
