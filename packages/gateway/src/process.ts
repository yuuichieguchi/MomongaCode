import path from 'node:path';
import {
  createPinnedDerivation,
  createStopValuesReader,
  createUserSettingsCache,
  credentialEnvNames,
  derivedInputsOf,
  diskKeptRecords,
  keptSettingsDirectory,
  loadUserSettings,
  probeRecordKeyOf,
  readUserStopValues,
  resolveNetwork,
  resolveTelemetrySettings,
  settingsInputsDigest,
  upstreamEndpointOf,
} from '@momonga/config';
import type { ResolvedSettings } from '@momonga/config';
import { MANAGED_SERVERS, managedServerOf } from '@momonga/protocol';
import type { ManagedServerDescription } from '@momonga/protocol';
import {
  acquireProcessLock,
  SecretEmptyError,
  SecretUnavailableError,
  announceReady,
  createJsonLogger,
  createGivenSecretStore,
  givenSecretStoreChildEnv,
  EntryUsageError,
  minimalChildEnv,
  CREDENTIAL_CAPABILITY_ENV,
  CREDENTIAL_CAPABILITY_HEADER,
  createUdsClient,
  fixedSocket,
  SETTINGS_APPLIED_ENV,
  nodeFileSystemSync,
  startDeadlineSignal,
  codeDigestOfRunningProcess,
  createBinaryHashCache,
  createHeldHostReadings,
  managedInstancePaths,
  momongaPaths,
  secretKeyFile,
  sweepLeftovers,
  hostKernelLock,
  leftoverDirectories,
  ensureGenerationDirs,
  generationLayout,
} from '@momonga/foundation';
import type { EndpointProbeKey, StopValuesReader } from '@momonga/config';
import type { BinaryHashCache, Clock, JsonLogger, MomongaPaths, NetworkConfig, OutboundNetwork, ProcessLock, ReadyFields, SecretStore, StopValues, TextStream } from '@momonga/foundation';
import { installTrust, trustFailureText, proxyPasswordsOf } from '@momonga/foundation';
import {
  buildCostReport,
  definePriceTable,
  formatCostReport,
  createTelemetry,
  exportersFor,
  openTraceStore,
  pageBilledCalls,
  startBodyPurge,
} from '@momonga/observability';
import type { PriceTable, Telemetry, TraceStore } from '@momonga/observability';
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
import { ANTHROPIC_PROVIDER_NAME, OLLAMA_PROVIDER_NAME, GATEWAY_CONFIG_DEFAULTS } from './defaults.ts';
import { missingApiKeyError, secretUnavailableError } from './core/errors.ts';
import { MIN_CREDENTIAL_CHARS } from './core/redaction.ts';
import { PreconditionFailedError } from './adapters/shared/failures.ts';
import { createManagedServer } from './managed/server.ts';
import type { ManagedServer, ManagedServerTimers, SpawnFn } from './managed/server.ts';
import type { ExecFn } from './managed/preconditions.ts';
import { createExecFn, createExecWithStdin } from './managed/fm-processes.ts';
import { PROBE_RETRY_AFTER_MS, createAutoProbe } from './probe/auto-probe.ts';
import type { AutoProbe, MeasureProbe } from './probe/auto-probe.ts';
import { createInstanceProbe } from './probe/instance-probe.ts';
import { loadProbeRecord } from './probe/record.ts';
import type { ManagedRecordCurrency, ManagedRecordKey } from './probe/record.ts';
import { lockKeyOf, managedCurrencyOf, managedKeyReader, managedPrecondition, managedProbeSubject, measureManagedServer } from './probe/probe-fm.ts';
import { endpointPrecondition, endpointProbeSubject, measureEndpoint } from './probe/probe-endpoint.ts';
import type { EndpointMeasurement } from './probe/probe-endpoint.ts';
import { measureOllama, ollamaPrecondition, ollamaProbeSubject } from './probe/ollama.ts';
import type { OllamaMeasurement } from './probe/ollama.ts';
import { endpointKeyOfLock, endpointLockKeyOf } from './probe/endpoint-record.ts';
import type { EndpointKey, EndpointLockKey } from './probe/endpoint-record.ts';
import { createManagedTarget } from './managed/target.ts';
import type { ExecWithStdinFn, ManagedTarget } from './managed/target.ts';
import { createGateway } from './server/gateway.ts';
import { createUnservedAdapter } from './adapters/unserved-adapter.ts';
import { createRouter } from './core/router.ts';
import { createReasoningOriginCodec } from './core/reasoning-origin.ts';
import { createRedactor } from './core/redaction.ts';
import type { GatewayEpoch, GatewayEpochs } from './core/services.ts';
import { systemProcessPorts } from './process-ports.ts';
import type { ProcessFilePorts } from './process-ports.ts';
import type { GatewayConfig, GatewayEpochsShared, GatewayTimers } from './types.ts';

export type StartGatewayProcessOptions = {
  home: string;
  generation: number;
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  clock?: Clock;
  timers?: GatewayTimers;
  random?: () => number;
  files?: ProcessFilePorts;
  exec?: ExecFn;
  execWithStdin?: ExecWithStdinFn;
  secretStore?: SecretStore;
  debugTcp?: { port: number; tokenFile: string };
  spawn?: SpawnFn;
  logger?: JsonLogger;
  stdout?: TextStream;
  signal?: AbortSignal;
  acquireLock?: (lockPath: string) => Promise<ProcessLock>;
  managedServers?: readonly ManagedServerDescription[];
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

type ResolvedTargets = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'];
type ResolvedTarget = ResolvedTargets[string];
type PlanTarget = Extract<ResolvedTarget, { plan: unknown }>;
type ServedTarget = Exclude<ResolvedTarget, PlanTarget>;
type RemoteTarget = Exclude<ServedTarget, { adapter: 'managed' }>;
type KeyedTarget = Exclude<RemoteTarget, { adapter: 'ollama' }>;
type OllamaDetectable = Extract<RemoteTarget, { adapter: 'chat-completions' | 'open-responses' }>;

const modelFieldOf = (model: string | undefined): { model?: string } => (model === undefined ? {} : { model });

const declaredCapabilitiesOf = (target: RemoteTarget, mode: ToolCallingMode): DeclaredCapabilities => ({ ...target.capabilities, toolCalling: mode });

const capabilitiesOf = (target: RemoteTarget, mode: ToolCallingMode): Capabilities => withImageDefault(declaredCapabilitiesOf(target, mode));

const startupFailureOf = (error: unknown): Error | undefined =>
  error instanceof SecretUnavailableError || error instanceof SecretEmptyError ? error : undefined;

type HandedCredential = (name: string, signal: AbortSignal) => Promise<string | undefined>;

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED']);

const handedValueOf = (text: string): string | undefined => {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof answer !== 'object' || answer === null) return undefined;
  const value = (answer as Record<string, unknown>)['value'];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const credentialFromSupervisor =
  (socketPath: string, capability: string | undefined, redact: (value: string) => void): HandedCredential =>
  async (name, signal) => {
    if (capability === undefined || capability === '') return undefined;
    const client = createUdsClient(fixedSocket(socketPath));
    try {
      const response = await client.request({ method: 'GET', path: `/v1/credentials/${encodeURIComponent(name)}`, headers: { [CREDENTIAL_CAPABILITY_HEADER]: capability }, signal });
      const text = await response.text();
      if (response.status !== 200) return undefined;
      const value = handedValueOf(text);
      if (value === undefined) return undefined;
      redact(value);
      return value;
    } catch (error) {
      if (UNREACHABLE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
      throw error;
    } finally {
      client.destroy();
    }
  };

const apiKeyReader = (
  env: StartGatewayProcessOptions['env'],
  resolver: SecretResolver,
  target: Pick<KeyedTarget, 'apiKeyEnv' | 'apiKeySecret'>,
  handed: HandedCredential,
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
    const own = env[apiKeyEnv];
    if (own !== undefined && own !== '') return own;
    const value = await handed(apiKeyEnv, signal);
    if (value === undefined) throw missingApiKeyError(apiKeyEnv);
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

const SAMPLING_OF: Record<ManagedServerDescription['sampling'], { renders: [] }> = { none: { renders: [] } };

const requiredServer = (servers: readonly ManagedServerDescription[], id: string): ManagedServerDescription => {
  const description = managedServerOf(servers, id);
  if (description === undefined) throw new Error(`server ${JSON.stringify(id)} is not a managed server this build supports; supported: ${servers.map((server) => server.id).join(', ')}`);
  return description;
};

type ManagedAdapterWiring = {
  name: string;
  target: Extract<ResolvedTarget, { adapter: 'managed' }>;
  description: ManagedServerDescription;
  paths: MomongaPaths;
  generation: number;
  childEnv: Readonly<Record<string, string>>;
  exec: ExecFn;
  execWithStdin: ExecWithStdinFn;
  hashes: BinaryHashCache;
  files: ProcessFilePorts;
  autoProbe: AutoProbe;
  probeServers: Set<ManagedServer>;
  timers: ManagedServerTimers;
  readStopGraceMs: () => number;
  requestLimitMs: number;
  keySignal: AbortSignal;
  incarnation: number;
  userDialects: UserDialects;
  spawn?: SpawnFn;
  onWarning: (message: string) => void;
};

const listedModelOf = async (wiring: ManagedAdapterWiring, key: ManagedRecordKey, currency: ManagedRecordCurrency): Promise<string | undefined> => {
  if (wiring.target.model !== undefined) return undefined;
  const report = await loadProbeRecord(wiring.paths.probe, key, currency, wiring.name);
  return report?.modelId;
};

type ManagedCore = { managed: ManagedTarget; probeKey: string | undefined; listedModel: string | undefined };

const createManagedCore = async (wiring: ManagedAdapterWiring): Promise<ManagedCore> => {
  const { name, target, description, paths } = wiring;
  const serving = managedInstancePaths(paths, { owner: 'gateway', generation: wiring.generation, purpose: 'serve', target: name, incarnation: wiring.incarnation });
  const probing = managedInstancePaths(paths, { owner: 'gateway', generation: wiring.generation, purpose: 'probe', target: name });
  const host = createHeldHostReadings();
  const readKey = managedKeyReader({ description, binary: target.binary, model: target.model, exec: wiring.exec, platform: process.platform, hashes: wiring.hashes, host });
  const freshKey = managedKeyReader({ description, binary: target.binary, model: target.model, exec: wiring.exec, platform: process.platform, hashes: wiring.hashes });
  const currency = managedCurrencyOf(description, { userDialects: wiring.userDialects });
  const spawnPort = wiring.spawn === undefined ? {} : { spawn: wiring.spawn };
  let managed: ManagedTarget | undefined;
  const server = createManagedServer({
    description,
    target: name,
    binary: target.binary,
    socketPath: serving.socketPath,
    lockPath: serving.lockPath,
    markerDirectory: serving.markerDirectory,
    readyTimeoutMs: target.readyTimeoutMs,
    env: wiring.childEnv,
    exec: wiring.exec,
    timers: wiring.timers,
    readStopGraceMs: wiring.readStopGraceMs,
    onWarning: wiring.onWarning,
    onChildExit: () => managed?.childExited(),
    ...spawnPort,
  });
  const measure = measureManagedServer({
    description,
    target: name,
    binary: target.binary,
    instance: probing,
    readyTimeoutMs: target.readyTimeoutMs,
    env: wiring.childEnv,
    exec: wiring.exec,
    execWithStdin: wiring.execWithStdin,
    userDialects: wiring.userDialects,
    servers: wiring.probeServers,
    timers: wiring.timers,
    readStopGraceMs: wiring.readStopGraceMs,
    onWarning: wiring.onWarning,
    ...modelFieldOf(target.model),
    ...spawnPort,
  });
  const subject = managedProbeSubject({
    target: name,
    precondition: managedPrecondition(description, name, target.binary, wiring.exec, wiring.files.isUsableBinary, wiring.requestLimitMs),
    probeRecordDir: paths.probe,
    readKey: freshKey,
    keySignal: () => AbortSignal.timeout(wiring.requestLimitMs),
    measure,
    currency,
  });
  managed = await createManagedTarget({
    description,
    server,
    binary: target.binary,
    exec: wiring.execWithStdin,
    probeRecordDir: paths.probe,
    target: name,
    requestLimitMs: wiring.requestLimitMs,
    isUsableBinary: wiring.files.isUsableBinary,
    readKey,
    onInstanceEnd: () => host.release(),
    startProbe: (key) => wiring.autoProbe.ensure(subject, lockKeyOf(key)),
    instanceProbe: (unknown) =>
      createInstanceProbe({
        target: name,
        unknown,
        dir: paths.probe,
        measure: (signal) => measure({ key: {}, signal }),
        retryAfterMs: PROBE_RETRY_AFTER_MS,
        onNotice: wiring.onWarning,
        onFailure: (error) => wiring.onWarning(`the measurement of the target ${name} failed: ${error instanceof Error ? error.message : String(error)}`),
      }),
    currency,
    ...(target.capabilities === undefined ? {} : { declaredCapabilities: target.capabilities }),
    toolCallingSetting: target.toolCalling,
    userDialects: wiring.userDialects,
    ...(target.model === undefined ? {} : { declaredModel: target.model }),
    ...(target.outputBoundField === undefined ? {} : { declaredOutputBoundField: target.outputBoundField }),
  });
  const startKey = (await wiring.files.isUsableBinary(target.binary)) ? await readKey(wiring.keySignal) : undefined;
  if (startKey?.kind !== 'known') return { managed, probeKey: undefined, listedModel: undefined };
  return { managed, probeKey: startKey.canonical, listedModel: await listedModelOf(wiring, startKey, currency) };
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

const NOT_LISTED_YET = 'not listed yet';

const providerNameOf = (target: ResolvedTarget, servers: readonly ManagedServerDescription[]): string => {
  switch (target.adapter) {
    case 'managed':
      return requiredServer(servers, target.server).provider;
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

export const gatewayConfigOf = (
  targets: ResolvedTargets,
  aliases: Record<string, string | string[]>,
  servers: readonly ManagedServerDescription[] = MANAGED_SERVERS,
  listedModels: ReadonlyMap<string, string> = new Map(),
): UncountedGatewayConfig => ({
  models: {
    aliases: Object.fromEntries(Object.entries(aliases).map(([alias, members]) => [alias, [members].flat()])),
    targets: Object.fromEntries(
      Object.entries(targets).map(([name, target]) => [
        name,
        {
          kind: target.adapter,
          provider: providerNameOf(target, servers),
          model: target.model ?? listedModels.get(name) ?? NOT_LISTED_YET,
          billing: target.billing,
          maxConcurrency: target.maxConcurrency,
          admissionTimeoutMs: target.admissionTimeoutMs,
        },
      ]),
    ),
  },
  ...GATEWAY_CONFIG_DEFAULTS,
});

const appliedRecordOf = (env: StartGatewayProcessOptions['env']): { appliedRecord?: string } => {
  const record = env[SETTINGS_APPLIED_ENV];
  return record === undefined ? {} : { appliedRecord: record };
};

type Closable = { close(values: StopValues | undefined): Promise<void> };

type ManagedPart = ManagedCore & { readonly key: string; readonly closable: Closable };

type TargetPart = {
  readonly key: string;
  readonly adapter: ProviderAdapter;
  readonly counter: string;
  readonly listedModel: string | undefined;
  readonly managed?: ManagedPart;
  readonly closables: readonly Closable[];
};

type ProcessEpoch = {
  readonly gateway: GatewayEpoch;
  readonly priceTable: PriceTable;
  readonly parts: ReadonlyMap<string, TargetPart>;
  readonly network: OutboundNetwork;
  readonly networkDigest: string;
};

const adapterClosable = (adapter: ProviderAdapter): Closable => ({ close: async (values) => adapter.close?.(values) });

const unmanagedPart = (key: string, adapter: ProviderAdapter, counter: string): TargetPart => ({ key, adapter, counter, listedModel: undefined, closables: [adapterClosable(adapter)] });

export const startGatewayProcess = async (options: StartGatewayProcessOptions): Promise<GatewayProcess> => {
  const clock = options.clock ?? systemProcessPorts.clock;
  const timers = options.timers ?? systemProcessPorts.timers;
  const random = options.random ?? systemProcessPorts.random;
  const files = options.files ?? systemProcessPorts.files;
  const logger = options.logger ?? createJsonLogger({ service: 'gateway', clock });
  const managedServers = options.managedServers ?? MANAGED_SERVERS;
  const { signal } = options;
  const startSignal = startDeadlineSignal(signal);
  const stdout = options.stdout ?? process.stdout;
  const paths = momongaPaths(options.home, process.platform, {});
  signal?.throwIfAborted();
  const own = generationLayout(options.home, options.generation);
  await ensureGenerationDirs(paths, options.generation);
  signal?.throwIfAborted();
  const lock = await (options.acquireLock ?? acquireProcessLock)(own.locks.gateway);
  const cleanups: Array<() => void | Promise<void>> = [() => lock.release()];
  const lifetime = new AbortController();
  const unwind = async (): Promise<Error[]> => {
    lifetime.abort(new Error('the gateway is closing'));
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
    const cache = createUserSettingsCache({
      home: options.home,
      onWarning: (message) => logger.warn(message),
      keptRecords: diskKeptRecords(nodeFileSystemSync, keptSettingsDirectory(options.home)),
      managedServers,
      ...appliedRecordOf(options.env),
    });
    const started = cache.snapshot();
    if ('error' in started) throw started.error;
    const { settings } = started;
    stopValues.remember(settings.gateway);
    const outboundNetworkOf = async (section: ResolvedSettings['network'], installSignal: AbortSignal | undefined): Promise<OutboundNetwork> => {
      const config = resolveNetwork(section, options.env);
      const outbound: OutboundNetwork = { config, trust: await installTrust(config, files, installSignal === undefined ? {} : { signal: installSignal }) };
      for (const failure of outbound.trust.failures) logger.warn(trustFailureText(failure));
      return outbound;
    };
    const network = await outboundNetworkOf(settings.network, signal);
    signal?.throwIfAborted();
    await sweepLeftovers({ directories: leftoverDirectories(paths), lock: hostKernelLock(), warn: (message) => logger.warn(message) });
    const hmacKey = secretKeyFile(paths.gatewayKey, {
      mustExist: files.databaseExists(paths.databases.gateway),
      dependentPath: paths.databases.gateway,
    });
    const traceStore: TraceStore = openTraceStore({ path: paths.traces.gateway, clock });
    cleanups.push(() => traceStore.close());
    const telemetryOf = (current: ResolvedSettings, outbound: OutboundNetwork): Telemetry => {
      const resolved = resolveTelemetrySettings(current.telemetry);
      return createTelemetry({
        serviceName: 'momonga-gateway',
        serviceVersion: options.version,
        clock,
        store: traceStore,
        exporters: exportersFor(current.telemetry, outbound),
        captureMessageContent: resolved.captureMessageContent,
        contentRetentionMs: resolved.contentRetentionDays * DAY_MS,
      });
    };
    const telemetries = createPinnedDerivation<Telemetry>({
      cache,
      signal: lifetime.signal,
      inputsOf: derivedInputsOf('D2'),
      derive: async (current, _previous, deriveSignal) => telemetryOf(current, await outboundNetworkOf(current.network, deriveSignal)),
      retire: async (retired) => {
        await retired.forceFlush();
        await retired.shutdown();
      },
      onWarning: (message) => logger.warn(message),
    });
    cleanups.push(() => telemetries.retireAll());
    (await telemetries.admit(startSignal)).release();
    const contentRetentionMs = resolveTelemetrySettings(settings.telemetry).contentRetentionDays * DAY_MS;
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

    const autoProbe = createAutoProbe({
      dir: paths.probe,
      clock,
      retryAfterMs: PROBE_RETRY_AFTER_MS,
      onEvent: (event) => {
        if (event.kind === 'stopped') logger.info(`the automatic probe of the target ${event.target} was stopped`);
        else logger.warn(`the automatic probe of the target ${event.target} failed and recorded nothing`, { err: event.error });
      },
    });
    const probeServers = new Set<ManagedServer>();
    const closeProbes = async (): Promise<void> => {
      await Promise.all([autoProbe.close(), ...[...probeServers].map((server) => server.stop(closeValues === undefined ? undefined : { stopGraceMs: closeValues.managedServerStopGraceMs }))]);
    };
    cleanups.push(closeProbes);
    const probes: ProbeWiring = {
      autoProbe,
      ...(options.measureEndpoint === undefined ? {} : { measureEndpoint: options.measureEndpoint }),
      ...(options.measureOllama === undefined ? {} : { measureOllama: options.measureOllama }),
    };
    const readStopGraceMs = (): number => stopValues.read().managedServerStopGraceMs;
    const managedTimers: ManagedServerTimers = { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => clock.now() };
    const hashes = createBinaryHashCache();
    const execWithStdin = options.execWithStdin ?? createExecWithStdin(childEnv);
    signal?.throwIfAborted();
    const codeDigest = await codeDigestOfRunningProcess();
    const secretStore =
      options.secretStore ?? createGivenSecretStore(options.execWithStdin ?? createExecWithStdin({ ...childEnv, ...givenSecretStoreChildEnv(options.env) }), options.env);
    const secretResolverOfPart = (): SecretResolver => {
      const resolver = createSecretResolver(secretStore);
      resolver.onResolved((name, value) => {
        for (const credential of credentialValuesOf({}, [], new Map([[name, value]]), (message) => logger.warn(message), undefined)) shared.redactor.add(credential);
      });
      return resolver;
    };
    signal?.throwIfAborted();

    let handedCredential: HandedCredential = async () => undefined;
    const holds = new Map<Closable, number>();
    const hold = (closable: Closable): void => {
      holds.set(closable, (holds.get(closable) ?? 0) + 1);
    };
    const letGo = async (closable: Closable): Promise<void> => {
      const left = (holds.get(closable) ?? 0) - 1;
      if (left > 0) {
        holds.set(closable, left);
        return;
      }
      holds.delete(closable);
      await closable.close(closeValues);
    };
    const closablesOf = (epoch: ProcessEpoch): Closable[] => [...epoch.parts.values()].flatMap((part) => part.closables);
    const liveEpochs = new Set<ProcessEpoch>();
    const incarnations = new Map<string, number>();
    const nextIncarnation = (name: string): number => {
      const incarnation = (incarnations.get(name) ?? 0) + 1;
      incarnations.set(name, incarnation);
      return incarnation;
    };

    const buildPart = async (
      name: string,
      target: ServedTarget,
      current: ResolvedSettings,
      outbound: OutboundNetwork,
      keySignal: AbortSignal,
      previous: TargetPart | undefined,
      keys: { part: string; core: string },
    ): Promise<TargetPart> => {
      const userDialects = current.models.dialects;
      const liveness: UpstreamLiveness = { headersTimeoutMs: current.models.headersTimeoutMs, idleTimeoutMs: current.models.idleTimeoutMs, timers };
      if (target.adapter === 'managed') {
        const carried = previous?.managed !== undefined && previous.managed.key === keys.core ? previous.managed : undefined;
        const core =
          carried ??
          (await (async (): Promise<ManagedPart> => {
            const built = await createManagedCore({
              name,
              target,
              description: requiredServer(managedServers, target.server),
              paths,
              childEnv,
              exec,
              execWithStdin,
              hashes,
              files,
              autoProbe,
              probeServers,
              timers: managedTimers,
              readStopGraceMs,
              requestLimitMs: current.models.headersTimeoutMs,
              keySignal,
              incarnation: nextIncarnation(name),
              generation: options.generation,
              userDialects,
              onWarning: (message) => logger.warn(message),
              ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
            });
            return { key: keys.core, ...built, closable: { close: (values) => built.managed.close(values) } };
          })());
        const { close: _stopsTheServer, ...serving } = core.managed;
        const adapter = createChatCompletionsAdapter({ ...serving, sampling: SAMPLING_OF[requiredServer(managedServers, target.server).sampling], clock, userDialects, liveness });
        return {
          key: keys.part,
          adapter,
          counter: targetCounterOf({ target, codeDigest, ...(core.probeKey === undefined ? {} : { probeKey: core.probeKey }) }),
          listedModel: core.listedModel,
          managed: core,
          closables: [adapterClosable(adapter), core.closable],
        };
      }
      if (target.adapter === 'ollama') {
        const probed = await createProbedOllamaAdapter(name, target, paths.probe, clock, userDialects, liveness, outbound, probes);
        return unmanagedPart(keys.part, probed.adapter, targetCounterOf({ target, codeDigest, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) }));
      }
      const readKey = apiKeyReader(options.env, secretResolverOfPart(), target, handedCredential);
      const identify = identificationOf(name, target, outbound);
      if (target.adapter === 'chat-completions' && target.toolCalling === 'auto') {
        const probed = await createAutoChatCompletionsAdapter(name, target, readKey, paths.probe, clock, identify, userDialects, liveness, outbound, probes);
        return unmanagedPart(keys.part, probed.adapter, targetCounterOf({ target, codeDigest, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) }));
      }
      const mode: ToolCallingMode = target.toolCalling === 'auto' ? 'native' : target.toolCalling;
      const common = {
        resolveEndpoint: async (_target: AdapterTarget, requestSignal: AbortSignal) => {
          await identify(requestSignal);
          return reachableEndpoint(upstreamEndpointOf(target), outbound);
        },
        capabilities: async () => capabilitiesOf(target, mode),
        clock,
        userDialects,
        liveness,
      };
      const counter = targetCounterOf({ target, codeDigest });
      switch (target.adapter) {
        case 'chat-completions':
          return unmanagedPart(keys.part, createChatCompletionsAdapter({ ...common, schemaDialect: () => resolveDialectId(target.capabilities.schemaDialect, null), apiKey: readKey }), counter);
        case 'open-responses':
          return unmanagedPart(keys.part, createOpenResponsesAdapter({ ...common, apiKey: readKey }), counter);
        case 'anthropic':
          return unmanagedPart(
            keys.part,
            createAnthropicAdapter({ ...common, apiVersion: target.apiVersion, apiKey: (adapterTarget, keyedSignal) => requiredKey(readKey, adapterTarget, keyedSignal) }),
            counter,
          );
      }
    };

    const deriveEpoch = async (shared: GatewayEpochsShared, current: ResolvedSettings, previous: ProcessEpoch | undefined, keySignal: AbortSignal): Promise<ProcessEpoch> => {
      const networkDigest = settingsInputsDigest(current.network ?? null);
      const outbound = previous !== undefined && previous.networkDigest === networkDigest ? previous.network : await outboundNetworkOf(current.network, keySignal);
      const shape = { userDialects: current.models.dialects, headersTimeoutMs: current.models.headersTimeoutMs, idleTimeoutMs: current.models.idleTimeoutMs };
      const parts = new Map<string, TargetPart>();
      const built: Closable[] = [];
      try {
        for (const [name, target] of Object.entries(current.models.targets) as Array<[string, ResolvedTarget]>) {
          if ('plan' in target) {
            const reason = `target ${name} uses plan profile ${target.plan.profile}, which this gateway does not serve yet`;
            logger.warn(reason);
            parts.set(name, unmanagedPart(settingsInputsDigest({ target }), createUnservedAdapter(reason), targetCounterOf({ target, codeDigest })));
            continue;
          }
          const keys = {
            part: settingsInputsDigest({ target, ...shape, network: target.adapter === 'managed' ? null : (current.network ?? null) }),
            core: settingsInputsDigest({ target, userDialects: shape.userDialects, requestLimitMs: shape.headersTimeoutMs }),
          };
          const livePartsOf = [previous, ...liveEpochs].flatMap((epoch) => {
            const part = epoch?.parts.get(name);
            return part === undefined ? [] : [part];
          });
          const kept = livePartsOf.find((part) => part.key === keys.part);
          if (kept !== undefined) {
            parts.set(name, kept);
            continue;
          }
          const carriedCore = livePartsOf.find((part) => part.managed?.key === keys.core);
          const part = await buildPart(name, target, current, outbound, keySignal, carriedCore ?? livePartsOf[0], keys);
          built.push(...part.closables.filter((closable) => !holds.has(closable)));
          parts.set(name, part);
        }
      } catch (error) {
        await Promise.all(built.map((closable) => closable.close(undefined)));
        throw error;
      }
      const listedModels = new Map([...parts].flatMap(([name, part]): Array<[string, string]> => (part.listedModel === undefined ? [] : [[name, part.listedModel]])));
      const counters = Object.fromEntries([...parts].map(([name, part]) => [name, part.counter]));
      const config = withCounters(gatewayConfigOf(current.models.targets, current.models.aliases, managedServers, listedModels), counters);
      const adapters: Record<string, ProviderAdapter> = {};
      for (const [name, part] of parts) {
        adapters[name] = part.adapter;
      }
      const router = createRouter({
        config,
        adapters,
        clock,
        timers,
        redactor: shared.redactor,
        reasoningOrigin: shared.reasoningOrigin,
        ...(previous === undefined ? {} : { previous: previous.gateway.router }),
        live: [...liveEpochs].map((epoch) => epoch.gateway.router),
      });
      for (const credential of credentialValuesOf(options.env, credentialEnvNames(current), new Map(), (message) => logger.warn(message), outbound.config)) shared.redactor.add(credential);
      const priceTable = definePriceTable(current.pricing === undefined ? [] : current.pricing);
      const epoch: ProcessEpoch = {
        gateway: { router, priceTable, telemetry: undefined },
        priceTable,
        parts,
        network: outbound,
        networkDigest,
      };
      for (const closable of closablesOf(epoch)) hold(closable);
      liveEpochs.add(epoch);
      return epoch;
    };

    const shared: GatewayEpochsShared = { redactor: createRedactor({ credentials: [] }), reasoningOrigin: createReasoningOriginCodec(hmacKey) };
    handedCredential = credentialFromSupervisor(own.sockets.supervisor, options.env[CREDENTIAL_CAPABILITY_ENV], (value) => shared.redactor.add(value));
    const derivation = createPinnedDerivation<ProcessEpoch>({
      cache,
      signal: lifetime.signal,
      inputsOf: derivedInputsOf('D1'),
      derive: (current, previous, deriveSignal) => deriveEpoch(shared, current, previous, deriveSignal),
      retire: async (epoch) => {
        liveEpochs.delete(epoch);
        await Promise.all(closablesOf(epoch).map(letGo));
      },
      onWarning: (message) => logger.warn(message),
    });
    const retireEpochsAtFailedStart = (): Promise<void> => derivation.retireAll();
    cleanups.push(retireEpochsAtFailedStart);
    (await derivation.admit(startSignal)).release();
    const epochs: GatewayEpochs = {
      acquire: async (requestSignal) => {
        const lease = await derivation.acquire(requestSignal);
        try {
          const traced = await telemetries.acquire(requestSignal);
          return {
            value: { ...lease.value.gateway, telemetry: traced.value },
            release: () => {
              traced.release();
              lease.release();
            },
          };
        } catch (error) {
          lease.release();
          throw error;
        }
      },
      close: () => derivation.retireAll(),
    };
    const flushTelemetry = async (requestSignal: AbortSignal): Promise<void> => {
      const traced = await telemetries.acquire(requestSignal);
      try {
        await traced.value.forceFlush();
      } finally {
        traced.release();
      }
    };
    const withPriceTable = async <T>(signal: AbortSignal, work: (priceTable: PriceTable) => Promise<T>): Promise<T> => {
      const lease = await derivation.acquire(signal);
      try {
        return await work(lease.value.priceTable);
      } finally {
        lease.release();
      }
    };

    signal?.throwIfAborted();
    const gateway = await createGateway({
      startSignal,
      limits: GATEWAY_CONFIG_DEFAULTS,
      epochs,
      ...shared,
      credentials: [],
      clock,
      timers,
      random,
      dbPath: paths.databases.gateway,
      hmacKey,
      socketPath: own.sockets.gateway,
      ...(options.debugTcp === undefined ? {} : { debugTcp: { host: DEBUG_TCP_HOST, port: options.debugTcp.port, token: files.readDebugToken(options.debugTcp.tokenFile) } }),
      costReport: (runs, includeRunless, requestSignal) =>
        withPriceTable(requestSignal, async (table) => {
          await flushTelemetry(requestSignal);
          const report = buildCostReport(traceStore, runs, { table, includeRunless });
          return { report, text: formatCostReport(report) };
        }),
      billedCalls: (runIds, cursor, limit, includeRunless, requestSignal) =>
        withPriceTable(requestSignal, async (table) => {
          await flushTelemetry(requestSignal);
          return pageBilledCalls(traceStore, runIds, table, cursor, limit, includeRunless);
        }),
      version: options.version,
      onError: (error) => logger.error('unhandled gateway error', { err: toError(error) }),
      onFatal: latchFatal,
    });
    if (gateway.tcpPort !== undefined) logger.info('gateway.debug_listener', { data: { host: DEBUG_TCP_HOST, port: gateway.tcpPort } });
    cleanups.splice(cleanups.indexOf(closeProbes), 1);
    cleanups.splice(cleanups.indexOf(retireEpochsAtFailedStart), 1);
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
