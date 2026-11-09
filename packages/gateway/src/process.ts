import path from 'node:path';
import { createStopValuesReader, credentialEnvNames, loadUserSettings, probeRecordKeyOf, readUserStopValues, resolveNetwork, resolveTelemetrySettings, secretNames, upstreamEndpointOf } from '@momonga/config';
import {
  acquireProcessLock,
  SecretEmptyError,
  SecretUnavailableError,
  announceReady,
  createJsonLogger,
  createGivenSecretStore,
  givenSecretStoreChildEnv,
  EntryUsageError,
  ensureMomongaDirs,
  minimalChildEnv,
  adapterSocketPath,
  codeDigestOfRunningProcess,
  momongaPaths,
  secretKeyFile,
  ensureGenerationDirs,
  generationLayout,
} from '@momonga/foundation';
import type { EndpointProbeKey, StopValuesReader } from '@momonga/config';
import type { Clock, JsonLogger, MomongaPaths, NetworkConfig, OutboundNetwork, ProcessLock, ReadyFields, SecretStore, StopValues, TextStream } from '@momonga/foundation';
import { installTrust, proxyPasswordsOf } from '@momonga/foundation';
import {
  buildCostReport,
  closeTelemetry,
  definePriceTable,
  formatCostReport,
  createTelemetry,
  exportersFor,
  openTraceStore,
  pageBilledCalls,
  startBodyPurge,
} from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import type { AdapterTarget, Capabilities, DialectId, ProviderAdapter, ToolCallingMode } from '@momonga/protocol';
import { NO_USER_DIALECTS } from './dialect/choice.ts';
import type { UserDialects } from './dialect/choice.ts';
import type { DialectCurrency } from './dialect/candidates.ts';
import { resolveDialectId } from './dialect/resolve-id.ts';
import { PROBE_METHOD_VERSION } from './probe/run-probe.ts';
import { chatRecordOf, loadEndpointRecord, ollamaRecordOf, saveEndpointRecord } from './probe/endpoint-record.ts';
import type { DeclaredCapabilities } from './probe/decide.ts';
import { withImageDefault } from './probe/decide.ts';
import { createProbedEndpointTarget, endpointKeyOf, ollamaServerRefusal, probeEndpointOf, readEndpointIdentity } from './probe/endpoint-target.ts';
import { answersAsOllama, readOllamaDigest } from './probe/ollama.ts';
import { createProbedOllamaTarget } from './probe/ollama-target.ts';
import { createSecretResolver } from './secrets.ts';
import { targetCounterOf } from './target-counter.ts';
import type { SecretResolver } from './secrets.ts';
import { reachableEndpoint } from './adapters/shared/http-client.ts';
import type { UpstreamLiveness } from './adapters/shared/http-client.ts';
import { createAnthropicAdapter } from './adapters/anthropic/adapter.ts';
import { createChatCompletionsAdapter } from './adapters/chat-completions/adapter.ts';
import { createOllamaAdapter } from './adapters/ollama/adapter.ts';
import { createOpenResponsesAdapter } from './adapters/open-responses/adapter.ts';
import type { UpstreamEndpoint } from './adapters/shared/http-client.ts';
import {
  ANTHROPIC_PROVIDER_NAME,
  FM_PROVIDER_NAME,
  FM_SERVE_DEFAULTS,
  OLLAMA_PROVIDER_NAME,
  GATEWAY_CONFIG_DEFAULTS,
} from './defaults.ts';
import { missingApiKeyError, secretUnavailableError } from './core/errors.ts';
import { MIN_CREDENTIAL_CHARS } from './core/redaction.ts';
import { PRECONDITION_MESSAGE, createFmServe } from './managed/fm-serve.ts';
import { PreconditionFailedError } from './adapters/shared/failures.ts';
import type { ExecFn, FmServe, FmServeTimers, SpawnFn } from './managed/fm-serve.ts';
import { createExecFn, createExecWithStdin } from './managed/fm-processes.ts';
import { createFmKeyCache, readOsBuild } from './managed/fm-record-key.ts';
import { PROBE_RETRY_AFTER_MS, createAutoProbe, targetNotReadyError } from './probe/auto-probe.ts';
import type { AutoProbe, MeasureProbe } from './probe/auto-probe.ts';
import { fmDialectCurrencyOf, fmProbeSubject, measureManagedFm } from './probe/probe-fm.ts';
import { endpointPrecondition, endpointProbeSubject, measureEndpoint } from './probe/probe-endpoint.ts';
import type { EndpointMeasurement } from './probe/probe-endpoint.ts';
import { measureOllama, ollamaPrecondition, ollamaProbeSubject } from './probe/ollama.ts';
import type { OllamaMeasurement } from './probe/ollama.ts';
import { endpointKeyOfLock, endpointLockKeyOf } from './probe/endpoint-record.ts';
import type { EndpointKey, EndpointLockKey } from './probe/endpoint-record.ts';
import type { ProbeRecordKey } from './probe/record.ts';
import type { ProbeReport } from '@momonga/protocol';
import { createManagedFmTarget } from './managed/fm-target.ts';
import type { ExecWithStdinFn, ManagedFmTarget } from './managed/fm-target.ts';
import { createGateway } from './server/gateway.ts';
import { systemProcessPorts } from './process-ports.ts';
import type { ProcessFilePorts } from './process-ports.ts';
import type { GatewayConfig, GatewayTimers } from './types.ts';

export type StartGatewayProcessOptions = {
  home: string;
  generation: number;
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  clock?: Clock;
  timers?: GatewayTimers;
  random?: () => number;
  files?: ProcessFilePorts;
  fmBinary?: string;
  exec?: ExecFn;
  execWithStdin?: ExecWithStdinFn;
  secretStore?: SecretStore;
  debugTcp?: { port: number; tokenFile: string };
  spawn?: SpawnFn;
  logger?: JsonLogger;
  stdout?: TextStream;
  signal?: AbortSignal;
  acquireLock?: (lockPath: string) => Promise<ProcessLock>;
  measureFm?: MeasureProbe<ProbeRecordKey, ProbeReport>;
  measureEndpoint?: MeasureEndpointPort<EndpointMeasurement>;
  measureOllama?: MeasureEndpointPort<OllamaMeasurement>;
  stopValues?: StopValuesReader;
};

export type GatewayCloseResult = {
  clean: boolean;
  abandonedRuns: number;
  failures: Error[];
  fatal?: Error;
};

export type GatewayProcess = {
  ready: ReadyFields;
  socketPath: string;
  close(values?: StopValues): Promise<GatewayCloseResult>;
  abort(values?: StopValues): Promise<GatewayCloseResult>;
  fatal: Promise<Error>;
};

type Phase = 'starting' | 'running' | 'closing' | 'closed';

const DAY_MS = 24 * 60 * 60 * 1000;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const failuresOf = (error: unknown): Error[] => (error instanceof AggregateError ? error.errors.map(toError) : [toError(error)]);

const closeTogether = async (closing: readonly Promise<unknown>[]): Promise<void> => {
  const failures = (await Promise.allSettled(closing)).flatMap((outcome) => (outcome.status === 'rejected' ? failuresOf(outcome.reason) : []));
  if (failures.length > 0) throw new AggregateError(failures, 'the gateway and its probes did not close cleanly');
};

const DEFAULT_FM_BINARY = '/usr/bin/fm';

type ResolvedTargets = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'];
type ResolvedTarget = ResolvedTargets[string];
type PlanTarget = Extract<ResolvedTarget, { plan: unknown }>;
type ServedTarget = Exclude<ResolvedTarget, PlanTarget>;
type RemoteTarget = Exclude<ServedTarget, { adapter: 'fm' }>;
type KeyedTarget = Exclude<RemoteTarget, { adapter: 'ollama' }>;
type OllamaDetectable = Extract<RemoteTarget, { adapter: 'chat-completions' | 'open-responses' }>;

const withBinaryGuard = (managed: ManagedFmTarget, binary: string, files: ProcessFilePorts): ManagedFmTarget => {
  const detail = `fm binary not found at ${binary}`;
  return {
    ...managed,
    resolveEndpoint: async (target) => {
      if (!(await files.isUsableBinary(binary))) {
        throw new PreconditionFailedError(PRECONDITION_MESSAGE, detail, undefined);
      }
      return managed.resolveEndpoint(target);
    },
    health: async (target) =>
      (await files.isUsableBinary(binary)) ? managed.health(target) : { ok: false, reason: 'precondition_failed', detail },
  };
};

const modelFieldOf = (model: string | undefined): { model?: string } => (model === undefined ? {} : { model });

const declaredCapabilitiesOf = (target: RemoteTarget, mode: ToolCallingMode): DeclaredCapabilities => ({ ...target.capabilities, toolCalling: mode });

const capabilitiesOf = (target: RemoteTarget, mode: ToolCallingMode): Capabilities => withImageDefault(declaredCapabilitiesOf(target, mode));

const startupFailureOf = (error: unknown): Error | undefined =>
  error instanceof SecretUnavailableError || error instanceof SecretEmptyError ? error : undefined;

const warmSecrets = async (resolver: SecretResolver, names: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, Error>> => {
  const failures = new Map<string, Error>();
  for (const name of names) {
    try {
      await resolver.read(name, signal);
    } catch (error) {
      const failure = startupFailureOf(error);
      if (failure === undefined) throw error;
      failures.set(name, failure);
    }
  }
  return failures;
};

const apiKeyReader = (
  env: StartGatewayProcessOptions['env'],
  resolver: SecretResolver,
  target: Pick<KeyedTarget, 'apiKeyEnv' | 'apiKeySecret'>,
): ((target: AdapterTarget, signal: AbortSignal) => Promise<string | undefined>) => {
  const { apiKeyEnv, apiKeySecret } = target;
  return async (_target, signal) => {
    if (apiKeySecret !== undefined) {
      try {
        return await resolver.read(apiKeySecret, signal);
      } catch (error) {
        const failure = startupFailureOf(error);
        if (failure === undefined) throw error;
        throw secretUnavailableError(apiKeySecret, failure);
      }
    }
    if (apiKeyEnv === undefined) return undefined;
    const value = env[apiKeyEnv];
    if (value === undefined || value === '') throw missingApiKeyError(apiKeyEnv);
    return value;
  };
};

const requiredKey = async (read: ReturnType<typeof apiKeyReader>, target: AdapterTarget, signal: AbortSignal): Promise<string> => {
  const key = await read(target, signal);
  if (key === undefined) throw new Error(`the anthropic target "${target.name}" has no credential reference`);
  return key;
};

const credentialValuesOf = (
  env: StartGatewayProcessOptions['env'],
  envNames: readonly string[],
  secretValues: ReadonlyMap<string, string>,
  warn: (message: string) => void,
  network: NetworkConfig | undefined,
): string[] => {
  const labelled: Array<[string, string | undefined]> = [
    ...envNames.map((name): [string, string | undefined] => [name, env[name]]),
    ...[...secretValues].map(([name, value]): [string, string | undefined] => [`secret ${name}`, value]),
    ...(network === undefined ? [] : proxyPasswordsOf(network)).map(({ source, password }): [string, string | undefined] => [`the proxy password of ${source}`, password]),
  ];
  return labelled.flatMap(([label, value]) => {
    if (value === undefined || value.trim() === '') return [];
    if (value.trim().length < MIN_CREDENTIAL_CHARS) {
      warn(`${label} holds fewer than ${MIN_CREDENTIAL_CHARS} characters, so its value is not redacted from upstream text`);
      return [];
    }
    return [value];
  });
};

type FmContext = {
  paths: MomongaPaths;
  binary: string;
  fmServe: FmServe;
  execWithStdin: ExecWithStdinFn;
  osBuild: string;
  binarySha256: string | { unreadable: string };
  readRecordKey: (target: string) => Promise<ProbeRecordKey>;
  autoProbe: AutoProbe;
  exec: ExecFn;
  measure: (target: string) => MeasureProbe<ProbeRecordKey, ProbeReport>;
};

type MeasureEndpointPort<Measurement> = (request: { key: EndpointKey; signal: AbortSignal }) => Promise<Measurement>;

type ProbeWiring = {
  autoProbe: AutoProbe;
  measureEndpoint?: MeasureEndpointPort<EndpointMeasurement>;
  measureOllama?: MeasureEndpointPort<OllamaMeasurement>;
};

const onRecordKey =
  <Measurement>(port: MeasureEndpointPort<Measurement>): MeasureProbe<EndpointLockKey, Measurement> =>
  ({ key, signal }) =>
    port({ key: endpointKeyOfLock(key), signal });

const createFmAdapter = async (name: string, target: Extract<ResolvedTarget, { adapter: 'fm' }>, context: FmContext, clock: Clock, files: ProcessFilePorts, userDialects: UserDialects, liveness: UpstreamLiveness) => {
  const managed = await createManagedFmTarget({
    fmServe: context.fmServe,
    binary: context.binary,
    exec: context.execWithStdin,
    probeRecordDir: context.paths.probe,
    target: name,
    readRecordKey: () => context.readRecordKey(name),
    startProbe: (key) =>
      context.autoProbe.ensure(
        fmProbeSubject({
          target: name,
          binary: context.binary,
          exec: context.exec,
          probeRecordDir: context.paths.probe,
          readKey: () => context.readRecordKey(name),
          measure: context.measure(name),
          currency: fmDialectCurrencyOf({ userDialects }),
        }),
        key,
      ),
    ...(target.capabilities === undefined ? {} : { declaredCapabilities: target.capabilities }),
    toolCallingSetting: target.toolCalling,
    userDialects,
    ...(target.model === undefined ? {} : { declaredModel: target.model }),
    ...(target.outputBoundField === undefined ? {} : { declaredOutputBoundField: target.outputBoundField }),
  });
  return createChatCompletionsAdapter({ ...withBinaryGuard(managed, context.binary, files), sampling: { renders: [] }, clock, userDialects, liveness });
};

const dialectCurrencyOf = (declaredDialect: DialectId | undefined, userDialects: UserDialects = NO_USER_DIALECTS): DialectCurrency => ({
  userDialects,
  probeMethod: PROBE_METHOD_VERSION,
  ...(declaredDialect === undefined ? {} : { declaredDialect }),
});

const endpointProbeKeyOf = (name: string, target: ResolvedTarget): EndpointProbeKey => {
  const key = probeRecordKeyOf(name, target);
  if (key?.kind !== 'endpoint') throw new Error(`the target ${name} has no endpoint probe record`);
  return key.key;
};

const createAutoChatCompletionsAdapter = async (
  name: string,
  target: Extract<RemoteTarget, { adapter: 'chat-completions' }>,
  readKey: ReturnType<typeof apiKeyReader>,
  probeRecordDir: string,
  clock: Clock,
  identify: Identification,
  userDialects: UserDialects,
  liveness: UpstreamLiveness,
  network: OutboundNetwork,
  probes: ProbeWiring,
) => {
  const upstream = reachableEndpoint(upstreamEndpointOf(target), network);
  const key = endpointProbeKeyOf(name, target);
  const { endpoint } = key;
  const currency = dialectCurrencyOf(target.capabilities.schemaDialect, userDialects);
  const readRecord = async () => chatRecordOf(await loadEndpointRecord(probeRecordDir, key, currency), key);
  const loaded = await readRecord();
  const apiKeyNow = (signal: AbortSignal) => readKey({ name, model: target.model }, signal);
  const subject = endpointProbeSubject({
    target: endpointLockKeyOf(key).target,
    key,
    probeRecordDir,
    precondition: endpointPrecondition(name, upstream, target.model, apiKeyNow),
    measure:
      (probes.measureEndpoint === undefined ? undefined : onRecordKey(probes.measureEndpoint)) ??
      (async (request) =>
        measureEndpoint({
          upstream,
          model: target.model,
          apiKey: await apiKeyNow(request.signal),
          userDialects,
          ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
        })(request)),
    currency,
  });
  const probed = createProbedEndpointTarget({
    targetName: name,
    endpoint,
    model: target.model,
    declared: declaredCapabilitiesOf(target, 'native'),
    record: loaded,
    readRecord,
    startProbe: () => probes.autoProbe.ensure(subject, endpointLockKeyOf(key)),
    readIdentity: async (fields, signal) => {
      const apiKey = await readKey({ name, model: target.model }, signal);
      return readEndpointIdentity(probeEndpointOf(upstream, apiKey), target.model, fields, signal);
    },
    saveRecord: (record) =>
      saveEndpointRecord(probeRecordDir, key, record.identity, record.identityFields, record.report, dialectCurrencyOf(target.capabilities.schemaDialect, userDialects)),
  });
  const adapter = createChatCompletionsAdapter({
    resolveEndpoint: async (_target, signal) => {
      await identify(signal);
      await probed.verify(signal);
      return upstream;
    },
    keywordSupport: () => probed.keywordSupport(),
    schemaDialect: () => probed.schemaDialect(),
    constructSupport: () => probed.constructSupport(),
    envelopeShape: () => probed.envelopeShape(),
    capabilities: () => probed.capabilities(),
    onSummaryReasoning: (_target, hiddenReasoningTokens) => probed.raiseHeadroom(hiddenReasoningTokens),
    apiKey: readKey,
    clock,
    userDialects,
    liveness,
  });
  return { adapter, upstreamIdentity: loaded?.identity };
};

const createProbedOllamaAdapter = async (
  name: string,
  target: Extract<RemoteTarget, { adapter: 'ollama' }>,
  probeRecordDir: string,
  clock: Clock,
  userDialects: UserDialects,
  liveness: UpstreamLiveness,
  network: OutboundNetwork,
  probes: ProbeWiring,
) => {
  const upstream = reachableEndpoint(upstreamEndpointOf(target), network);
  const key = endpointProbeKeyOf(name, target);
  const { endpoint } = key;
  const currency = dialectCurrencyOf(target.capabilities.schemaDialect, userDialects);
  const readRecord = async () => ollamaRecordOf(await loadEndpointRecord(probeRecordDir, key, currency), key);
  const loaded = await readRecord();
  const subject = ollamaProbeSubject({
    target: endpointLockKeyOf(key).target,
    key,
    probeRecordDir,
    precondition: ollamaPrecondition(upstream, target.model),
    measure:
      (probes.measureOllama === undefined ? undefined : onRecordKey(probes.measureOllama)) ??
      measureOllama({
        upstream,
        model: target.model,
        contextWindow: target.capabilities.contextWindow,
        userDialects,
        ...(target.capabilities.schemaDialect === undefined ? {} : { declaredDialect: target.capabilities.schemaDialect }),
      }),
    currency,
  });
  const probed = createProbedOllamaTarget({
    targetName: name,
    endpoint,
    model: target.model,
    declared: declaredCapabilitiesOf(target, 'native'),
    record: loaded,
    readRecord,
    startProbe: () => probes.autoProbe.ensure(subject, endpointLockKeyOf(key)),
    readDigest: (signal) => readOllamaDigest(upstream, target.model, signal),
  });
  const adapter = createOllamaAdapter({
    resolveEndpoint: async (_target, signal) => {
      await probed.verify(signal);
      return upstream;
    },
    capabilities: () => probed.capabilities(),
    clock,
    userDialects,
    liveness,
  });
  return { adapter, upstreamIdentity: loaded?.identity };
};

type Identification = (signal: AbortSignal) => Promise<void>;

const UNIDENTIFIED = Symbol('unidentified');

const ollamaIdentificationOf = (name: string, target: OllamaDetectable, network: OutboundNetwork): Identification => {
  let refusal: PreconditionFailedError | null | typeof UNIDENTIFIED = UNIDENTIFIED;
  return async (signal) => {
    if (refusal === UNIDENTIFIED) {
      const isOllama = await answersAsOllama(reachableEndpoint(upstreamEndpointOf(target), network), signal);
      refusal = isOllama ? ollamaServerRefusal(name, target.adapter, endpointKeyOf(upstreamEndpointOf(target))) : null;
    }
    if (refusal !== null) throw refusal;
  };
};

const NO_IDENTIFICATION: Identification = async () => undefined;

const identificationOf = (name: string, target: ServedTarget, network: OutboundNetwork): Identification =>
  (target.adapter === 'chat-completions' || target.adapter === 'open-responses') && target.baseUrl !== undefined ? ollamaIdentificationOf(name, target, network) : NO_IDENTIFICATION;

const DEBUG_TCP_HOST = '127.0.0.1';

const providerNameOf = (target: ResolvedTarget): string => {
  switch (target.adapter) {
    case 'fm':
      return FM_PROVIDER_NAME;
    case 'anthropic':
      return ANTHROPIC_PROVIDER_NAME;
    case 'chat-completions':
    case 'open-responses':
      return target.provider;
    case 'ollama':
      return OLLAMA_PROVIDER_NAME;
  }
};

const requiredCounter = (counters: Readonly<Record<string, string>>, name: string): string => {
  const counter = counters[name];
  if (counter === undefined) throw new Error(`no counter was derived for the target ${name}`);
  return counter;
};

type UncountedGatewayConfig = Omit<GatewayConfig, 'models'> & {
  models: { aliases: GatewayConfig['models']['aliases']; targets: Record<string, Omit<GatewayConfig['models']['targets'][string], 'counter'>> };
};

const withCounters = (config: UncountedGatewayConfig, counters: Readonly<Record<string, string>>): GatewayConfig => ({
  ...config,
  models: {
    aliases: config.models.aliases,
    targets: Object.fromEntries(Object.entries(config.models.targets).map(([name, target]) => [name, { ...target, counter: requiredCounter(counters, name) }])),
  },
});

export const gatewayConfigOf = (targets: ResolvedTargets, aliases: Record<string, string | string[]>): UncountedGatewayConfig => ({
  models: {
    aliases: Object.fromEntries(Object.entries(aliases).map(([alias, members]) => [alias, [members].flat()])),
    targets: Object.fromEntries(
      Object.entries(targets).map(([name, target]) => [
        name,
        {
          kind: target.adapter,
          provider: providerNameOf(target),
          model: target.adapter === 'fm' ? (target.model ?? name) : target.model,
          billing: target.billing,
          maxConcurrency: target.maxConcurrency,
          admissionTimeoutMs: target.admissionTimeoutMs,
        },
      ]),
    ),
  },
  ...GATEWAY_CONFIG_DEFAULTS,
});

export const startGatewayProcess = async (options: StartGatewayProcessOptions): Promise<GatewayProcess> => {
  const clock = options.clock ?? systemProcessPorts.clock;
  const timers = options.timers ?? systemProcessPorts.timers;
  const random = options.random ?? systemProcessPorts.random;
  const files = options.files ?? systemProcessPorts.files;
  const logger = options.logger ?? createJsonLogger({ service: 'gateway', clock });
  const binary = options.fmBinary ?? DEFAULT_FM_BINARY;
  const { signal } = options;
  const stdout = options.stdout ?? process.stdout;
  const paths = momongaPaths(options.home, process.platform, {});
  signal?.throwIfAborted();
  const own = generationLayout(options.home, options.generation);
  await ensureMomongaDirs(paths);
  await ensureGenerationDirs(paths, options.generation);
  signal?.throwIfAborted();
  const lock = await (options.acquireLock ?? acquireProcessLock)(own.locks.gateway);
  const cleanups: Array<() => void | Promise<void>> = [() => lock.release()];
  const unwind = async (): Promise<Error[]> => {
    const failures: Error[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(...failuresOf(error));
      }
    }
    return failures;
  };

  let phase: Phase = 'starting';
  let fatalError: Error | undefined;
  let resolveFatal: (error: Error) => void = () => undefined;
  const fatal = new Promise<Error>((resolve) => {
    resolveFatal = resolve;
  });
  let requestGatewayAbort: () => void = () => undefined;
  let gatewayAbandonedRuns: () => number = () => 0;
  let abortRequested = false;
  let lifecycle: Promise<GatewayCloseResult> | undefined;
  let closeValues: StopValues | undefined;
  const stopValues = options.stopValues ?? createStopValuesReader({ load: () => readUserStopValues(options.home), onNotice: (message) => logger.warn(message) });

  const shutdown = async (values: StopValues): Promise<GatewayCloseResult> => {
    phase = 'closing';
    closeValues = values;
    const failures = await unwind();
    phase = 'closed';
    const abandonedRuns = gatewayAbandonedRuns();
    if (abandonedRuns > 0) logger.warn('close.abandoned_runs', { count: abandonedRuns });
    return {
      clean: failures.length === 0 && fatalError === undefined,
      abandonedRuns,
      failures,
      ...(fatalError === undefined ? {} : { fatal: fatalError }),
    };
  };

  const close = (values?: StopValues): Promise<GatewayCloseResult> => {
    lifecycle ??= shutdown(values ?? stopValues.read());
    return lifecycle;
  };

  const abort = (values?: StopValues): Promise<GatewayCloseResult> => {
    abortRequested = true;
    if (lifecycle === undefined) lifecycle = shutdown(values ?? stopValues.read());
    else requestGatewayAbort();
    return lifecycle;
  };

  const latchFatal = (error: Error): void => {
    if (phase === 'closed') return;
    logger.error('gateway.fatal', { err: error });
    if (fatalError !== undefined) return;
    fatalError = error;
    resolveFatal(error);
    if (phase === 'running' || phase === 'closing') void abort();
  };

  try {
    signal?.throwIfAborted();
    const { settings, warnings } = await loadUserSettings({ home: options.home });
    for (const warning of warnings) logger.warn(warning);
    stopValues.remember(settings.gateway);
    const networkConfig = resolveNetwork(settings.network, options.env);
    const network: OutboundNetwork = { config: networkConfig, trust: await installTrust(networkConfig, files) };
    for (const failure of network.trust.failures) logger.warn(`the CA file ${failure.file} from ${failure.source} was not loaded: ${failure.reason}`);
    signal?.throwIfAborted();
    const hmacKey = secretKeyFile(paths.gatewayKey, {
      mustExist: files.databaseExists(paths.databases.gateway),
      dependentPath: paths.databases.gateway,
    });
    const priceTable = definePriceTable(settings.pricing === undefined ? [] : settings.pricing);
    const traceStore: TraceStore = openTraceStore({ path: paths.traces.gateway, clock });
    const telemetrySettings = resolveTelemetrySettings(settings.telemetry);
    const contentRetentionMs = telemetrySettings.contentRetentionDays * DAY_MS;
    const telemetry: Telemetry = createTelemetry({
      serviceName: 'momonga-gateway',
      serviceVersion: options.version,
      clock,
      store: traceStore,
      exporters: exportersFor(settings.telemetry, network),
      captureMessageContent: telemetrySettings.captureMessageContent,
      contentRetentionMs,
    });
    cleanups.push(() => closeTelemetry(telemetry, traceStore));
    const bodyPurge = startBodyPurge({
      store: traceStore,
      timers,
      report: (error) => logger.error('trace body purge failed', { err: toError(error) }),
      legacyRetentionMs: contentRetentionMs,
    });
    cleanups.push(() => bodyPurge.stop());

    signal?.throwIfAborted();
    const childEnv = minimalChildEnv(options.env);
    const exec = options.exec ?? createExecFn(childEnv);
    const targets = Object.entries(settings.models.targets).map(([name, target]): [string, ServedTarget] => {
      if ('plan' in target) throw new Error(`target ${name} uses plan profile ${target.plan.profile}, which this gateway does not serve yet`);
      return [name, target];
    });
    const adapters: Record<string, ProviderAdapter> = {};
    const closeAdapters = async (): Promise<void> => {
      await Promise.all(Object.values(adapters).map((adapter) => adapter.close?.()));
    };
    cleanups.push(closeAdapters);

    const fmTargets = targets.filter(([, target]) => target.adapter === 'fm');
    const fmModels = new Map(fmTargets.map(([name, target]) => [name, target.adapter === 'fm' ? target.model : undefined]));
    const fmKeys = createFmKeyCache(binary, exec, FM_SERVE_DEFAULTS.healthTimeoutMs);
    const readRecordKey = async (target: string): Promise<ProbeRecordKey> => {
      if (!(await files.isUsableBinary(binary))) {
        throw targetNotReadyError(target, { kind: 'refused', message: 'the fm binary is missing', detail: `fm binary not found at ${binary}`, remedy: undefined });
      }
      return fmKeys.read(target);
    };
    const autoProbe = createAutoProbe({
      dir: paths.probe,
      clock,
      retryAfterMs: PROBE_RETRY_AFTER_MS,
      onEvent: (event) => {
        if (event.kind === 'stopped') logger.info(`the automatic probe of the target ${event.target} was stopped`);
        else logger.warn(`the automatic probe of the target ${event.target} failed and recorded nothing`, { err: event.error });
      },
    });
    const probeServes = new Set<FmServe>();
    const closeProbes = async (): Promise<void> => {
      await Promise.all([autoProbe.close(), ...[...probeServes].map((serve) => serve.stop(closeValues === undefined ? undefined : { stopGraceMs: closeValues.managedServerStopGraceMs }))]);
    };
    cleanups.push(closeProbes);
    const probes: ProbeWiring = {
      autoProbe,
      ...(options.measureEndpoint === undefined ? {} : { measureEndpoint: options.measureEndpoint }),
      ...(options.measureOllama === undefined ? {} : { measureOllama: options.measureOllama }),
    };
    const startKey = fmTargets.length > 0 && (await files.isUsableBinary(binary)) ? await fmKeys.read('fm') : undefined;
    const readStopGraceMs = (): number => stopValues.read().managedServerStopGraceMs;
    const fmTimers: FmServeTimers = { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => clock.now() };
    const fmContext: FmContext | undefined =
      fmTargets.length === 0
        ? undefined
        : {
            paths,
            binary,
            fmServe: createFmServe({
              ...FM_SERVE_DEFAULTS,
              binary,
              socketPath: adapterSocketPath(options.home, 'fm', process.platform),
              env: childEnv,
              markerDirectory: path.join(paths.markers.targets, 'fm'),
              readStopGraceMs,
              onWarning: (message) => logger.warn(message),
              exec,
              ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
              timers: fmTimers,
            }),
            execWithStdin: options.execWithStdin ?? createExecWithStdin(childEnv),
            osBuild: startKey?.osBuild ?? (await readOsBuild(exec, AbortSignal.timeout(FM_SERVE_DEFAULTS.healthTimeoutMs))),
            binarySha256: startKey?.binarySha256 ?? { unreadable: `no usable binary at ${binary}` },
            readRecordKey,
            autoProbe,
            exec,
            measure: (target) =>
              options.measureFm ??
              measureManagedFm({
                binary,
                socketPath: adapterSocketPath(options.home, `fm-probe-${target}`, process.platform),
                env: options.env,
                exec,
                userDialects: settings.models.dialects,
                ...modelFieldOf(fmModels.get(target)),
                markerDirectory: path.join(paths.markers.targets, `fm-probe-${target}`),
                serves: probeServes,
                readStopGraceMs,
                onWarning: (message) => logger.warn(message),
                ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
                timers: fmTimers,
              }),
          };
    signal?.throwIfAborted();
    const codeDigest = await codeDigestOfRunningProcess();
    const counters: Record<string, string> = {};
    const referencedSecrets = secretNames(settings);
    const secretStore =
      options.secretStore ?? createGivenSecretStore(options.execWithStdin ?? createExecWithStdin({ ...childEnv, ...givenSecretStoreChildEnv(options.env) }), options.env);
    const secretResolver = createSecretResolver(secretStore);
    const secretFailures = await warmSecrets(secretResolver, referencedSecrets, signal ?? new AbortController().signal);
    for (const [name, failure] of secretFailures) logger.warn(`secret ${name} is unavailable: ${failure.message}`);
    signal?.throwIfAborted();
    const userDialects = settings.models.dialects;
    const liveness: UpstreamLiveness = { headersTimeoutMs: settings.models.headersTimeoutMs, idleTimeoutMs: settings.models.idleTimeoutMs, timers };
    for (const [name, target] of targets) {
      signal?.throwIfAborted();
      if (target.adapter === 'fm') {
        if (fmContext === undefined) throw new Error('fm context is missing for an fm target');
        adapters[name] = await createFmAdapter(name, target, fmContext, clock, files, userDialects, liveness);
        counters[name] = targetCounterOf({ target, codeDigest, fm: { binarySha256: typeof fmContext.binarySha256 === 'string' ? fmContext.binarySha256 : null, osBuild: fmContext.osBuild } });
        continue;
      }
      if (target.adapter === 'ollama') {
        const probed = await createProbedOllamaAdapter(name, target, paths.probe, clock, userDialects, liveness, network, probes);
        adapters[name] = probed.adapter;
        counters[name] = targetCounterOf({ target, codeDigest, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) });
        continue;
      }
      const readKey = apiKeyReader(options.env, secretResolver, target);
      const identify = identificationOf(name, target, network);
      if (target.adapter === 'chat-completions' && target.toolCalling === 'auto') {
        const probed = await createAutoChatCompletionsAdapter(name, target, readKey, paths.probe, clock, identify, userDialects, liveness, network, probes);
        adapters[name] = probed.adapter;
        counters[name] = targetCounterOf({ target, codeDigest, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) });
        continue;
      }
      counters[name] = targetCounterOf({ target, codeDigest });
      const mode: ToolCallingMode = target.toolCalling === 'auto' ? 'native' : target.toolCalling;
      const common = {
        resolveEndpoint: async (_target: AdapterTarget, requestSignal: AbortSignal) => {
          await identify(requestSignal);
          return reachableEndpoint(upstreamEndpointOf(target), network);
        },
        capabilities: async () => capabilitiesOf(target, mode),
        clock,
        userDialects,
        liveness,
      };
      switch (target.adapter) {
        case 'chat-completions':
          adapters[name] = createChatCompletionsAdapter({ ...common, schemaDialect: () => resolveDialectId(target.capabilities.schemaDialect, null), apiKey: readKey });
          break;
        case 'open-responses':
          adapters[name] = createOpenResponsesAdapter({ ...common, apiKey: readKey });
          break;
        case 'anthropic':
          adapters[name] = createAnthropicAdapter({ ...common, apiVersion: target.apiVersion, apiKey: (adapterTarget, signal) => requiredKey(readKey, adapterTarget, signal) });
          break;
      }
    }

    signal?.throwIfAborted();
    const gateway = await createGateway({
      config: withCounters(gatewayConfigOf(settings.models.targets, settings.models.aliases), counters),
      adapters,
      credentials: credentialValuesOf(options.env, credentialEnvNames(settings), secretResolver.resolved(), (message) => logger.warn(message), network.config),
      credentialFeed: (add) =>
        secretResolver.onResolved((name, value) => {
          for (const credential of credentialValuesOf({}, [], new Map([[name, value]]), (message) => logger.warn(message), undefined)) add(credential);
        }),
      clock,
      timers,
      random,
      dbPath: paths.databases.gateway,
      hmacKey,
      socketPath: own.sockets.gateway,
      ...(options.debugTcp === undefined ? {} : { debugTcp: { host: DEBUG_TCP_HOST, port: options.debugTcp.port, token: files.readDebugToken(options.debugTcp.tokenFile) } }),
      telemetry,
      priceTable,
      costReport: async (runs, includeRunless) => {
        await telemetry.forceFlush();
        const report = buildCostReport(traceStore, runs, { table: priceTable, includeRunless });
        return { report, text: formatCostReport(report) };
      },
      billedCalls: async (runIds, cursor, limit, includeRunless) => {
        await telemetry.forceFlush();
        return pageBilledCalls(traceStore, runIds, priceTable, cursor, limit, includeRunless);
      },
      version: options.version,
      onError: (error) => logger.error('unhandled gateway error', { err: toError(error) }),
      onFatal: latchFatal,
    });
    if (gateway.tcpPort !== undefined) logger.info('gateway.debug_listener', { data: { host: DEBUG_TCP_HOST, port: gateway.tcpPort } });
    cleanups.splice(cleanups.indexOf(closeAdapters), 1);
    cleanups.splice(cleanups.indexOf(closeProbes), 1);
    cleanups.push(() => closeTogether([abortRequested ? gateway.abort(closeValues) : gateway.close(closeValues), closeProbes()]));
    requestGatewayAbort = () => void gateway.abort(closeValues);
    gatewayAbandonedRuns = () => gateway.abandonedRuns;
    signal?.throwIfAborted();
    const ready: ReadyFields = { service: 'gateway', pid: process.pid, version: options.version, socketPath: gateway.socketPath, startedAt: gateway.startedAt };
    announceReady(ready, stdout);
    phase = 'running';
    if (fatalError !== undefined) void abort();

    return { ready, socketPath: gateway.socketPath, close, abort, fatal };
  } catch (error) {
    phase = 'closing';
    for (const cleanupFailure of await unwind()) logger.error('startup.cleanup_failed', { err: cleanupFailure });
    phase = 'closed';
    throw error;
  }
};
