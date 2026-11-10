import path from 'node:path';
import {
  PLAN_PROFILES,
  createPinnedDerivation,
  createStopValuesReader,
  createUserSettingsCache,
  credentialEnvNames,
  derivedInputsOf,
  diskKeptRecords,
  keptSettingsDirectory,
  loadUserSettings,
  probeRecordKeyOf,
  providerNameOf,
  readUserStopValues,
  registeredIds,
  registeredServer,
  requireOfferedEndpointForm,
  resolveNetwork,
  resolveTelemetrySettings,
  settingsInputsDigest,
  upstreamEndpointOf,
} from '@momonga/config';
import type { ResolvedModel, ResolvedModels, ResolvedSettings } from '@momonga/config';
import { CAPABILITIES_UNKNOWN_CODE, PLAN_USE_NOT_ENABLED_CODE, SERVER_KINDS, SIGN_IN_REQUIRED_CODE, USAGE_PAUSED_CODE, displayMapOf } from '@momonga/protocol';
import type { ManagedServerDescription, PlanHealthReason, TargetHealthReason, GatewayHealth } from '@momonga/protocol';
import {
  acquireProcessLock,
  JsonDepthError,
  parseOutsideJson,
  SecretEmptyError,
  SecretStoreAbsentError,
  SecretStoreAnswerError,
  SecretUnavailableError,
  StoreCallEndedError,
  operationLimit,
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
  requireGenerationDirs,
  generationLayout,
  createRolePort,
  endpointFormsOfSocket,
  pipePathFor,
  CONTROL_REQUEST_TIMEOUT_MS,
  EXIT_RETIRED,
  SWEEP_INTERVAL_MS,
} from '@momonga/foundation';
import type { EndpointProbeKey, PlanProfiles, ServerRegistry, StopValuesReader } from '@momonga/config';
import type {
  BinaryHashCache,
  Clock,
  EndpointForm,
  GenerationRole,
  JsonLogger,
  ListableCredentialStore,
  ManagedInstancePaths,
  MomongaPaths,
  NetworkConfig,
  OutboundNetwork,
  ProcessLock,
  ReadyFields,
  RolePort,
  SecretStore,
  StopValues,
  TextStream,
} from '@momonga/foundation';
import { createEncryptedCredentialStore, createFileCredentialStore, createOutboundDispatcher, givenCredentialSecretStore, installTrust, nodeFileSystem, outboundFetch, trustFailureText, proxyPasswordsOf } from '@momonga/foundation';
import {
  buildCostReport,
  definePriceTable,
  formatCostReport,
  createTelemetry,
  exportersFor,
  openTraceStore,
  pageBilledCalls,
  pageRunBodies,
  startBodyPurge,
} from '@momonga/observability';
import type { PriceTable, Telemetry, TraceStore } from '@momonga/observability';
import type { AdapterTarget, Capabilities, DialectId, HealthResult, ProviderAdapter, ToolCallingMode } from '@momonga/protocol';
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
import { keyReadLimitOf } from './key-read-limit.ts';
import type { KeyReadLimit } from './key-read-limit.ts';
import { createSecretResolver } from './secrets.ts';
import { readsOutputPolicy, targetCounterOf } from './target-counter.ts';
import type { ReportedNumbers, ServedAccount } from './target-counter.ts';
import type { SecretResolver } from './secrets.ts';
import { reachableEndpoint } from './adapters/shared/http-client.ts';
import type { UpstreamLiveness } from './adapters/shared/http-client.ts';
import { createAnthropicAdapter } from './adapters/anthropic/adapter.ts';
import { createChatCompletionsAdapter } from './adapters/chat-completions/adapter.ts';
import { createOllamaAdapter } from './adapters/ollama/adapter.ts';
import { createOpenResponsesAdapter } from './adapters/open-responses/adapter.ts';
import { keyAuthSource, unauthenticatedSource } from './adapters/shared/auth.ts';
import type { AdapterAuth } from './adapters/shared/auth.ts';
import { openPlanSessions, planRecordKeyOfPlaintext } from './plan/session.ts';
import { createPlanApi } from './plan/api.ts';
import { createPlanCatalog } from './plan/catalog.ts';
import { authSourceWithinRequestLimit } from './plan/request-limit.ts';
import { startSharedCall } from './plan/shared-call.ts';
import type { SharedCall } from './plan/shared-call.ts';
import { createPlanSignIn } from './plan/signin.ts';
import type { AuthSource, PlanHealth } from './plan/auth-source.ts';
import type { PlanEvents } from './plan/events.ts';
import type { PlanOutbound, PlanScope } from './plan/outbound.ts';
import type { PlanTargetRef } from './plan/api.ts';
import type { ProbeOutputPolicy } from './probe/decide.ts';
import type { UpstreamEndpoint } from './adapters/shared/http-client.ts';
import { GATEWAY_CONFIG_DEFAULTS, PLAN_SESSION_DEFAULTS } from './defaults.ts';
import { invalidRequest, missingApiKeyError, secretUnavailableError } from './core/errors.ts';
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
  measureEndpoint?: MeasureEndpointPort<EndpointMeasurement>;
  measureOllama?: MeasureEndpointPort<OllamaMeasurement>;
  stopValues?: StopValuesReader;
  planProfiles?: PlanProfiles;
  planStore?: (store: ListableCredentialStore) => ListableCredentialStore;
  role?: RolePort;
  requestShutdown?: () => void;
  runtimeHealth?: RuntimeHealthProbe;
};

export type RuntimeStanding = 'gone' | 'idle' | 'busy';

export const GATEWAY_STATE_IN_MODEL = { running: 'serving', retiring: 'retiring', draining: 'serving' } as const satisfies Record<GatewayHealth['state'], 'serving' | 'retiring'>;

export type RuntimeHealthProbe = (signal: AbortSignal) => Promise<RuntimeStanding>;

export type GatewayCloseResult = {
  clean: boolean;
  exitCode?: number;
  abandonedRuns: number;
  failures: Error[];
  fatal?: Error;
};

export type GatewayProcess = {
  ready: ReadyFields;
  socketPath: string;
  close(values?: StopValues): Promise<GatewayCloseResult>;
  abort(values?: StopValues): Promise<GatewayCloseResult>;
  role(): GenerationRole;
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

type ResolvedTarget = ResolvedModel;
type PlanTarget = Extract<ResolvedTarget, { plan: unknown }>;
type ServedTarget = Exclude<ResolvedTarget, PlanTarget>;
type RemoteTarget = Exclude<ServedTarget, { adapter: 'managed' }>;
type KeyedTarget = Exclude<RemoteTarget, { adapter: 'ollama' }>;
type OllamaDetectable = Extract<RemoteTarget, { adapter: 'chat-completions' | 'open-responses' }>;

const declaredCapabilitiesOf = (target: RemoteTarget, mode: ToolCallingMode): DeclaredCapabilities => ({ ...target.capabilities, toolCalling: mode });

const capabilitiesOf = (target: RemoteTarget, mode: ToolCallingMode): Capabilities => withImageDefault(declaredCapabilitiesOf(target, mode));

const READ_AGAIN_ON_THE_NEXT_REQUEST = 'the gateway reads the secret again on the next request';

const startupFailureOf = (error: unknown): Error | undefined => {
  if (error instanceof SecretUnavailableError || error instanceof SecretEmptyError) return error;
  if (error instanceof StoreCallEndedError) return new StoreCallEndedError(error.call, error.limit, READ_AGAIN_ON_THE_NEXT_REQUEST);
  if (error instanceof SecretStoreAbsentError || error instanceof SecretStoreAnswerError) return new Error(`${error.message}; ${READ_AGAIN_ON_THE_NEXT_REQUEST}`, { cause: error });
  return undefined;
};

type HandedCredential = (name: string, signal: AbortSignal) => Promise<string | undefined>;

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED']);

const runtimeStandingOf = (text: string): RuntimeStanding => {
  let health: unknown;
  try {
    health = parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return 'busy';
    throw error;
  }
  if (typeof health !== 'object' || health === null) return 'busy';
  const { state, steps } = health as Record<string, unknown>;
  return state === 'retiring' && steps === 0 ? 'idle' : 'busy';
};

const RUNTIME_HEALTH_PATH = '/v1/health';

export const runtimeHealthOver =
  (socketPath: string): RuntimeHealthProbe =>
  async (signal) => {
    const client = createUdsClient(fixedSocket(socketPath));
    try {
      const response = await client.request({ method: 'GET', path: RUNTIME_HEALTH_PATH, signal });
      const text = await response.text();
      return response.status === 200 ? runtimeStandingOf(text) : 'busy';
    } catch (error) {
      if (UNREACHABLE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return 'gone';
      throw error;
    } finally {
      client.destroy();
    }
  };

const handedValueOf = (text: string): string | undefined => {
  let answer: unknown;
  try {
    answer = parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return undefined;
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
  keyReadLimit: KeyReadLimit,
  timers: GatewayTimers,
): ((target: AdapterTarget, signal: AbortSignal) => Promise<string | undefined>) => {
  const { apiKeyEnv, apiKeySecret } = target;
  return async (_target, signal) => {
    if (apiKeySecret !== undefined) {
      const limit = operationLimit(signal, keyReadLimit.limitMs, keyReadLimit.label, timers);
      try {
        return await resolver.read(apiKeySecret, limit.signal);
      } catch (error) {
        const failure = startupFailureOf(error);
        if (failure === undefined) throw error;
        throw secretUnavailableError(apiKeySecret, failure);
      } finally {
        limit.dispose();
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
  if (key === undefined) throw new Error(`the model "${target.display}" has no credential reference`);
  return key;
};

const authSourceOf = (target: Pick<KeyedTarget, 'apiKeyEnv' | 'apiKeySecret'>, read: ReturnType<typeof apiKeyReader>): AdapterAuth =>
  target.apiKeyEnv === undefined && target.apiKeySecret === undefined ? unauthenticatedSource : keyAuthSource((adapterTarget, signal) => requiredKey(read, adapterTarget, signal));

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
  outputPolicy: () => ProbeOutputPolicy;
  measureEndpoint?: MeasureEndpointPort<EndpointMeasurement>;
  measureOllama?: MeasureEndpointPort<OllamaMeasurement>;
};

const onRecordKey =
  <Measurement>(port: MeasureEndpointPort<Measurement>): MeasureProbe<EndpointLockKey, Measurement> =>
  ({ key, signal }) =>
    port({ key: endpointKeyOfLock(key), signal });

const SAMPLING_OF: Record<ManagedServerDescription['sampling'], { renders: [] }> = { none: { renders: [] } };

const requiredServer = (servers: ServerRegistry | undefined, id: string): ManagedServerDescription => {
  const description = registeredServer(servers, id);
  if (description === undefined) throw new Error(`server ${JSON.stringify(id)} is not a managed server this build supports; supported: ${registeredIds(servers).join(', ')}`);
  return description;
};

type ManagedAdapterWiring = {
  display: string;
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
  role: RolePort;
  home: string;
  hostForms: readonly EndpointForm[];
  readStopGraceMs: () => number;
  requestLimitMs: number;
  keySignal: AbortSignal;
  incarnation: number;
  userDialects: UserDialects;
  spawn?: SpawnFn;
  onWarning: (message: string) => void;
};

const INSTANCE_SOCKET_SUFFIX = '.sock';

export const instanceSocketOf = (form: EndpointForm, unixSocketPath: string, home: string, generation: number): string =>
  form === 'pipe' ? pipePathFor(home, `g${generation}-managed-${path.basename(unixSocketPath, INSTANCE_SOCKET_SUFFIX)}`) : unixSocketPath;

type ManagedCore = { managed: ManagedTarget; probeKey: string | undefined };

const createManagedCore = async (wiring: ManagedAdapterWiring): Promise<ManagedCore> => {
  const { display, target, description, paths } = wiring;
  const { provider } = target;
  const form = requireOfferedEndpointForm(description, wiring.hostForms, `the server ${provider}`);
  const inForm = (instance: ManagedInstancePaths): ManagedInstancePaths => ({ ...instance, socketPath: instanceSocketOf(form, instance.socketPath, wiring.home, wiring.generation) });
  const serving = inForm(managedInstancePaths(paths, { owner: 'gateway', generation: wiring.generation, purpose: 'serve', provider, incarnation: wiring.incarnation }));
  const probing = inForm(managedInstancePaths(paths, { owner: 'gateway', generation: wiring.generation, purpose: 'probe', provider }));
  const host = createHeldHostReadings();
  const readKey = managedKeyReader({ description, binary: target.binary, model: target.model, exec: wiring.exec, platform: process.platform, hashes: wiring.hashes, host });
  const freshKey = managedKeyReader({ description, binary: target.binary, model: target.model, exec: wiring.exec, platform: process.platform, hashes: wiring.hashes });
  const currency = managedCurrencyOf(description, { userDialects: wiring.userDialects });
  const spawnPort = wiring.spawn === undefined ? {} : { spawn: wiring.spawn };
  let managed: ManagedTarget | undefined;
  const server = createManagedServer({
    description,
    target: display,
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
    onChildStart: async (signal) => {
      if (managed === undefined) throw new Error(`the server of the model ${display} started a child before the model was wired`);
      await managed.childStarting(signal);
    },
    onChildExit: () => managed?.childExited(),
    role: wiring.role,
    ...spawnPort,
  });
  const measure = measureManagedServer({
    description,
    target: display,
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
    model: target.model,
    ...spawnPort,
  });
  const subject = managedProbeSubject({
    target: display,
    precondition: managedPrecondition(description, display, target.binary, wiring.exec, wiring.files.isUsableBinary, wiring.requestLimitMs),
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
    target: display,
    requestLimitMs: wiring.requestLimitMs,
    isUsableBinary: wiring.files.isUsableBinary,
    readKey,
    onInstanceEnd: () => host.release(),
    startProbe: (key) => wiring.autoProbe.ensure(subject, lockKeyOf(key)),
    instanceProbe: (unknown) =>
      createInstanceProbe({
        target: display,
        unknown,
        dir: paths.probe,
        measure: (signal) => measure({ key: {}, signal }),
        retryAfterMs: PROBE_RETRY_AFTER_MS,
        clock: wiring.timers,
        onNotice: wiring.onWarning,
        onFailure: (error) => wiring.onWarning(`the measurement of the model ${display} failed: ${error instanceof Error ? error.message : String(error)}`),
      }),
    currency,
    ...(target.capabilities === undefined ? {} : { declaredCapabilities: target.capabilities }),
    toolCallingSetting: target.toolCalling,
    userDialects: wiring.userDialects,
    declaredModel: target.model,
    ...(target.outputBoundField === undefined ? {} : { declaredOutputBoundField: target.outputBoundField }),
  });
  const startKey = (await wiring.files.isUsableBinary(target.binary)) ? await readKey(wiring.keySignal) : undefined;
  return { managed, probeKey: startKey?.kind === 'known' ? startKey.canonical : undefined };
};

const dialectCurrencyOf = (declaredDialect: DialectId | undefined, userDialects: UserDialects = NO_USER_DIALECTS): DialectCurrency => ({
  userDialects,
  probeMethod: PROBE_METHOD_VERSION,
  ...(declaredDialect === undefined ? {} : { declaredDialect }),
});

const endpointProbeKeyOf = (target: ResolvedTarget): EndpointProbeKey => {
  const key = probeRecordKeyOf(target.canon, target);
  if (key?.kind !== 'endpoint') throw new Error(`the model ${target.canon} has no endpoint probe record`);
  return key.key;
};

const createAutoChatCompletionsAdapter = async (
  display: string,
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
  const key = endpointProbeKeyOf(target);
  const { endpoint } = key;
  const currency = dialectCurrencyOf(target.capabilities.schemaDialect, userDialects);
  const readRecord = async () => chatRecordOf(await loadEndpointRecord(probeRecordDir, key, currency), key);
  const loaded = await readRecord();
  const adapterTarget: AdapterTarget = { name: target.canon, display, model: target.model };
  const apiKeyNow = (signal: AbortSignal) => readKey(adapterTarget, signal);
  const subject = endpointProbeSubject({
    target: endpointLockKeyOf(key).target,
    key,
    probeRecordDir,
    precondition: endpointPrecondition(display, upstream, target.model, apiKeyNow),
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
    outputPolicy: probes.outputPolicy,
    targetName: display,
    endpoint,
    model: target.model,
    declared: declaredCapabilitiesOf(target, 'native'),
    record: loaded,
    readRecord,
    startProbe: () => probes.autoProbe.ensure(subject, endpointLockKeyOf(key)),
    readIdentity: async (fields, signal) => {
      const apiKey = await readKey(adapterTarget, signal);
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
    authSource: authSourceOf(target, readKey),
    clock,
    userDialects,
    liveness,
  });
  return { adapter, upstreamIdentity: loaded?.identity };
};

const createProbedOllamaAdapter = async (
  display: string,
  target: Extract<RemoteTarget, { adapter: 'ollama' }>,
  probeRecordDir: string,
  clock: Clock,
  userDialects: UserDialects,
  liveness: UpstreamLiveness,
  network: OutboundNetwork,
  probes: ProbeWiring,
) => {
  const upstream = reachableEndpoint(upstreamEndpointOf(target), network);
  const key = endpointProbeKeyOf(target);
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
    targetName: display,
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

const ollamaIdentificationOf = (display: string, target: OllamaDetectable, network: OutboundNetwork): Identification => {
  let refusal: PreconditionFailedError | null | typeof UNIDENTIFIED = UNIDENTIFIED;
  return async (signal) => {
    if (refusal === UNIDENTIFIED) {
      const isOllama = await answersAsOllama(reachableEndpoint(upstreamEndpointOf(target), network), signal);
      refusal = isOllama ? ollamaServerRefusal(display, target.adapter, endpointKeyOf(upstreamEndpointOf(target))) : null;
    }
    if (refusal !== null) throw refusal;
  };
};

const NO_IDENTIFICATION: Identification = async () => undefined;

const identificationOf = (display: string, target: ServedTarget, network: OutboundNetwork): Identification =>
  (target.adapter === 'chat-completions' || target.adapter === 'open-responses') && target.baseUrl !== undefined ? ollamaIdentificationOf(display, target, network) : NO_IDENTIFICATION;

const DEBUG_TCP_HOST = '127.0.0.1';

const sleepOn = (timers: GatewayTimers, ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = (): void => {
      timers.clearTimeout(handle);
      reject(signal?.reason);
    };
    const handle = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const HEALTH_REASON_OF_PLAN: Readonly<Record<PlanHealthReason, TargetHealthReason>> = {
  [SIGN_IN_REQUIRED_CODE]: SIGN_IN_REQUIRED_CODE,
  [PLAN_USE_NOT_ENABLED_CODE]: SIGN_IN_REQUIRED_CODE,
  [USAGE_PAUSED_CODE]: SIGN_IN_REQUIRED_CODE,
  store_unreadable: 'store_unreadable',
  store_unwritable: 'store_unwritable',
};

const healthResultOf = (health: PlanHealth): HealthResult => ({
  ok: health.ok,
  ...(health.reason === undefined ? {} : { reason: HEALTH_REASON_OF_PLAN[health.reason] }),
  ...(health.detail === undefined ? {} : { detail: health.detail }),
  ...(health.remediation === undefined ? {} : { remediation: health.remediation }),
});

type PlanAdapterWiring = { clock: Clock; userDialects: UserDialects; liveness: UpstreamLiveness; network: OutboundNetwork };

type PlanNumbers = { contextWindow: number; maxOutputTokens: number };

type PlanReported = () => PlanNumbers | undefined;

const PRECONDITION_STATUS = 412;

const planCapabilityNumbers = (target: PlanTarget, reported: PlanReported): PlanNumbers | undefined => {
  const { contextWindow, maxOutputTokens } = target.capabilities;
  return contextWindow !== undefined && maxOutputTokens !== undefined ? { contextWindow, maxOutputTokens } : reported();
};

const declaresPlanNumbers = (target: PlanTarget): boolean => planCapabilityNumbers(target, () => undefined) !== undefined;

const unknownCapabilitiesText = (target: PlanTarget): string =>
  `the model ${target.model} cannot be used yet: the settings give no context window and output limit for it, and the model list of its account reports none; momonga models catalog reads the list`;

const planCapabilitiesOf = (target: PlanTarget, reported: PlanReported): Capabilities => {
  const { contextWindow: _contextWindow, maxOutputTokens: _maxOutputTokens, ...rest } = target.capabilities;
  const numbers = planCapabilityNumbers(target, reported);
  if (numbers === undefined) throw invalidRequest(CAPABILITIES_UNKNOWN_CODE, unknownCapabilitiesText(target), 'model', PRECONDITION_STATUS);
  return withImageDefault({ ...rest, ...numbers, toolCalling: target.toolCalling });
};

const planHealthOf = (target: PlanTarget, auth: AuthSource, reported: PlanReported): HealthResult => {
  const authHealth = healthResultOf(auth.health());
  if (!authHealth.ok || planCapabilityNumbers(target, reported) !== undefined) return authHealth;
  return { ok: false, reason: CAPABILITIES_UNKNOWN_CODE, detail: unknownCapabilitiesText(target) };
};

const createPlanAdapter = (target: PlanTarget, auth: AuthSource, profiles: PlanProfiles, reported: PlanReported, wiring: PlanAdapterWiring): ProviderAdapter => {
  const profile = profiles[target.plan.profile];
  if (profile === undefined) throw new Error(`the plan model ${target.canon} names the unknown plan profile ${JSON.stringify(target.plan.profile)}`);
  return createOpenResponsesAdapter({
    resolveEndpoint: async () => reachableEndpoint(upstreamEndpointOf(target), wiring.network),
    capabilities: async () => planCapabilitiesOf(target, reported),
    health: async () => planHealthOf(target, auth, reported),
    authSource: () => auth,
    errorRules: profile.errorRules,
    clock: wiring.clock,
    userDialects: wiring.userDialects,
    liveness: wiring.liveness,
  });
};

const planTargetsOf = (settings: ResolvedSettings): PlanTarget[] => [...settings.models.models.values()].flatMap((target): PlanTarget[] => ('plan' in target ? [target] : []));

const planTargetRefsOf = (settings: ResolvedSettings): PlanTargetRef[] =>
  planTargetsOf(settings).map((target) => ({ name: target.canon, profile: target.plan.profile, ...(target.plan.account === undefined ? {} : { account: target.plan.account }) }));

const writtenProviderOf = (target: ResolvedTarget): string | undefined => {
  const { provider: _provider, ...connection } = target;
  return providerNameOf(connection, SERVER_KINDS) === target.provider ? undefined : target.provider;
};

const keyGroupOf = (target: ResolvedTarget): { keyGroup?: string } => {
  const fields: Readonly<Record<string, unknown>> = target;
  if (fields['apiKeyEnv'] === undefined && fields['apiKeySecret'] === undefined) return {};
  const written = writtenProviderOf(target);
  if (written !== undefined) return { keyGroup: written };
  const baseUrl = fields['baseUrl'];
  return { keyGroup: typeof baseUrl === 'string' ? new URL(baseUrl).origin : target.provider };
};

const planRefOf = (target: ResolvedTarget): { plan?: { profile: string; account?: string } } =>
  'plan' in target ? { plan: { profile: target.plan.profile, ...(target.plan.account === undefined ? {} : { account: target.plan.account }) } } : {};

const requiredCounter = (counters: Readonly<Record<string, string>>, name: string): string => {
  const counter = counters[name];
  if (counter === undefined) throw new Error(`no counter was derived for the model ${name}`);
  return counter;
};

type ConfiguredTargets = GatewayConfig['models']['targets'];

type UncountedGatewayConfig = Omit<GatewayConfig, 'models'> & {
  models: Omit<GatewayConfig['models'], 'targets'> & { targets: Record<string, Omit<ConfiguredTargets[string], 'counter'>> };
};

const withCounters = (config: UncountedGatewayConfig, counters: Readonly<Record<string, string>>): GatewayConfig => {
  const { targets, ...rest } = config.models;
  return {
    ...config,
    models: { ...rest, targets: Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, { ...target, counter: requiredCounter(counters, name) }])) },
  };
};

export const gatewayConfigOf = (resolved: Pick<ResolvedModels, 'models' | 'chains' | 'start' | 'roles' | 'billingChanges'>): UncountedGatewayConfig => ({
  models: {
    billingChanges: resolved.billingChanges,
    chains: Object.fromEntries([...resolved.chains].map(([model, members]) => [model, [...members]])),
    ...(resolved.start === undefined ? {} : { start: resolved.start }),
    roles: resolved.roles,
    targets: Object.fromEntries(
      [...resolved.models].map(([canon, target]) => [
        canon,
        {
          kind: target.adapter,
          provider: target.provider,
          model: target.model,
          ...(target.defaultTag === undefined ? {} : { defaultTag: target.defaultTag }),
          ...(target.answers === undefined ? {} : { answers: target.answers }),
          billing: target.billing,
          maxConcurrency: target.maxConcurrency,
          admissionTimeoutMs: target.admissionTimeoutMs,
          ...planRefOf(target),
          ...keyGroupOf(target),
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

const unmanagedPart = (key: string, adapter: ProviderAdapter, counter: string): TargetPart => ({ key, adapter, counter, closables: [adapterClosable(adapter)] });

export const startGatewayProcess = async (options: StartGatewayProcessOptions): Promise<GatewayProcess> => {
  const clock = options.clock ?? systemProcessPorts.clock;
  const timers = options.timers ?? systemProcessPorts.timers;
  const random = options.random ?? systemProcessPorts.random;
  const files = options.files ?? systemProcessPorts.files;
  const logger = options.logger ?? createJsonLogger({ service: 'gateway', clock });
  const { signal } = options;
  const role = options.role ?? createRolePort({ paths: momongaPaths(options.home, process.platform, {}), generation: options.generation, logger });
  const startSignal = startDeadlineSignal(signal);
  const stdout = options.stdout ?? process.stdout;
  const paths = momongaPaths(options.home, process.platform, {});
  signal?.throwIfAborted();
  const own = generationLayout(options.home, options.generation);
  await requireGenerationDirs(paths, options.generation);
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
  let retired = false;
  const stopValues = options.stopValues ?? createStopValuesReader({ load: () => readUserStopValues(options.home), onNotice: (message) => logger.warn(message) });

  const shutdown = async (values: StopValues): Promise<GatewayCloseResult> => {
    phase = 'closing';
    closeValues = values;
    const failures = await unwind();
    phase = 'closed';
    const abandonedRuns = gatewayAbandonedRuns();
    if (abandonedRuns > 0) logger.warn('close.abandoned_runs', { count: abandonedRuns });
    const clean = failures.length === 0 && fatalError === undefined;
    return {
      clean,
      abandonedRuns,
      failures,
      ...(clean && retired ? { exitCode: EXIT_RETIRED } : {}),
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
    const planProfiles = options.planProfiles ?? PLAN_PROFILES;
    const cache = createUserSettingsCache({
      home: options.home,
      onWarning: (message) => logger.warn(message),
      keptRecords: diskKeptRecords(nodeFileSystemSync, keptSettingsDirectory(options.home)),
      ...appliedRecordOf(options.env),
      planProfiles,
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
      role,
      onEvent: (event) => {
        if (event.kind === 'stopped') logger.info(`the automatic probe of the model ${event.target} was stopped`);
        else logger.warn(`the automatic probe of the model ${event.target} failed and recorded nothing`, { err: event.error });
      },
    });
    const probeServers = new Set<ManagedServer>();
    const closeProbes = async (): Promise<void> => {
      await Promise.all([autoProbe.close(), ...[...probeServers].map((server) => server.stop(closeValues === undefined ? undefined : { stopGraceMs: closeValues.managedServerStopGraceMs }))]);
    };
    cleanups.push(closeProbes);
    const probePorts: Omit<ProbeWiring, 'outputPolicy'> = {
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
    const shared: GatewayEpochsShared = { redactor: createRedactor({ credentials: [] }), reasoningOrigin: createReasoningOriginCodec(hmacKey) };
    type HeldPlanScope = PlanScope & { close(): Promise<void> };
    const planScopes = createPinnedDerivation<HeldPlanScope>({
      cache,
      signal: lifetime.signal,
      inputsOf: derivedInputsOf('D5'),
      derive: async (current, _previous, deriveSignal) => {
        const dispatcher = createOutboundDispatcher(await outboundNetworkOf(current.network, deriveSignal), {
          connectReplyTimeoutMs: Math.max(PLAN_SESSION_DEFAULTS.attemptTimeoutMs, PLAN_SESSION_DEFAULTS.revocationTimeoutMs),
        });
        return {
          fetch: (url, init) => outboundFetch(dispatcher)(url, init as never) as unknown as Promise<Response>,
          plaintextTokenFiles: current.credentials.plaintextTokenFiles,
          close: () => dispatcher.close(),
        };
      },
      retire: (scope) => scope.close(),
      onWarning: (message) => logger.warn(message),
    });
    cleanups.push(() => planScopes.retireAll());
    (await planScopes.admit(startSignal)).release();
    const withOutboundNetwork: PlanOutbound = async (operationSignal, use) => {
      const lease = await planScopes.acquire(operationSignal);
      try {
        return await use(lease.value.fetch);
      } finally {
        lease.release();
      }
    };
    const planEvents: PlanEvents = (name, data) => logger.info(name, { data });
    const planSleep = (ms: number, sleepSignal?: AbortSignal): Promise<void> => sleepOn(timers, ms, sleepSignal);
    await nodeFileSystem.mkdirPrivate(paths.planSessions);
    const planRecordStore = createEncryptedCredentialStore({
      directory: paths.planSessions,
      stateDirectory: paths.state,
      secretStore:
        options.secretStore === undefined
          ? givenCredentialSecretStore(options.execWithStdin ?? createExecWithStdin({ ...childEnv, ...givenSecretStoreChildEnv(options.env) }), options.env)
          : { kind: 'available', store: options.secretStore },
      plaintextTokenFiles: () => planScopes.current().plaintextTokenFiles,
      keyOfPlaintext: planRecordKeyOfPlaintext,
    });
    const sessions = await openPlanSessions({
      profiles: planProfiles,
      paths: { sessions: paths.planSessions, host: paths.planHost, active: paths.planActive },
      store: options.planStore === undefined ? planRecordStore : options.planStore(planRecordStore),
      fileSystem: nodeFileSystem,
      accounts: [],
      clock,
      outbound: withOutboundNetwork,
      sleep: planSleep,
      signal: startSignal,
      timing: timers,
      random,
      events: planEvents,
      redact: (key, values) => shared.redactor.set(key, values),
      warn: (message) => logger.warn(message),
    });
    cleanups.push(() => sessions.close());
    const catalog = createPlanCatalog({ store: createFileCredentialStore(paths.planCatalog), clock, outbound: withOutboundNetwork, sleep: planSleep, events: planEvents });
    const planApi = createPlanApi({
      catalog,
      home: options.home,
      settingsFile: paths.settingsFile,
      profiles: planProfiles,
      sessions,
      signIn: createPlanSignIn({
        profiles: planProfiles,
        sessions,
        clock,
        outbound: withOutboundNetwork,
        lifetime: sessions.lifetime,
        sleep: planSleep,
        fileSystem: nodeFileSystem,
        hostFile: paths.planHost,
        events: planEvents,
      }),
      clock,
    });
    const servedOf = (target: PlanTarget): ServedAccount => ({ profile: target.plan.profile, account: target.plan.account ?? sessions.activeLabel(target.plan.profile) ?? null });
    const reportedOf = (target: PlanTarget, served: ServedAccount): ReportedNumbers | undefined => {
      if (declaresPlanNumbers(target)) return undefined;
      return served.account === null ? null : (catalog.capabilitiesOf(served.profile, served.account, target.model) ?? null);
    };
    type PlanInput = { account: string | null; reported?: ReportedNumbers };
    type EpochInputs = { plan: Readonly<Record<string, PlanInput>> };
    const planInputsOf = (current: ResolvedSettings): Record<string, PlanInput> =>
      Object.fromEntries(
        planTargetsOf(current).map((target) => {
          const served = servedOf(target);
          const reported = reportedOf(target, served);
          return [target.canon, { account: served.account, ...(reported === undefined ? {} : { reported }) }];
        }),
      );
    const epochInputsOf = (current: ResolvedSettings): EpochInputs => ({ ...derivedInputsOf('D1')(current), plan: planInputsOf(current) });
    const planComponentsOf = (name: string, target: PlanTarget, inputs: EpochInputs): { served: ServedAccount; reported?: ReportedNumbers } => {
      const input = Object.hasOwn(inputs.plan, name) ? inputs.plan[name] : undefined;
      if (input === undefined) throw new Error(`the derivation inputs name no plan account for the model ${name}`);
      return { served: { profile: target.plan.profile, account: input.account }, ...(input.reported === undefined ? {} : { reported: input.reported }) };
    };
    const planLoaded = new Set<string>();
    const planLoads = new Map<string, SharedCall<void>>();
    const planLoadOf = (key: string, ref: { profile: string; account: string }, loadSignal: AbortSignal): Promise<void> => {
      const running = planLoads.get(key);
      if (running !== undefined) return running.join(loadSignal);
      const forget = (): void => {
        if (planLoads.get(key) === started) planLoads.delete(key);
      };
      const started: SharedCall<void> = startSharedCall(
        sessions.lifetime,
        (sharedSignal) =>
          Promise.all([sessions.load(ref, sharedSignal), catalog.load(ref.profile, ref.account, sharedSignal)])
            .then(() => {
              planLoaded.add(key);
            })
            .finally(forget),
        forget,
      );
      planLoads.set(key, started);
      return started.join(loadSignal);
    };
    const preparePlan = (current: ResolvedSettings, prepareSignal: AbortSignal): Promise<void> | undefined => {
      const pending = new Map(
        planTargetsOf(current).flatMap((target): Array<[string, { profile: string; account: string }]> => {
          const { profile, account } = servedOf(target);
          if (account === null) return [];
          const key = JSON.stringify([profile, account]);
          return planLoaded.has(key) ? [] : [[key, { profile, account }]];
        }),
      );
      if (pending.size === 0) return undefined;
      return Promise.all([...pending].map(([key, ref]) => planLoadOf(key, ref, prepareSignal))).then(() => undefined);
    };
    const secretResolverOfPart = (): SecretResolver => {
      const resolver = createSecretResolver(secretStore, secretStore.backend);
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
      display: string,
      target: ServedTarget,
      current: ResolvedSettings,
      outbound: OutboundNetwork,
      keySignal: AbortSignal,
      previous: TargetPart | undefined,
      keys: { part: string; core: string },
      outputPolicy: ProbeOutputPolicy,
    ): Promise<TargetPart> => {
      const probes: ProbeWiring = { ...probePorts, outputPolicy: () => outputPolicy };
      const userDialects = current.models.dialects;
      const liveness: UpstreamLiveness = { headersTimeoutMs: current.models.headersTimeoutMs, idleTimeoutMs: current.models.idleTimeoutMs, timers };
      if (target.adapter === 'managed') {
        const server = requiredServer(current.models.servers, target.server);
        const carried = previous?.managed !== undefined && previous.managed.key === keys.core ? previous.managed : undefined;
        const core =
          carried ??
          (await (async (): Promise<ManagedPart> => {
            const built = await createManagedCore({
              display,
              target,
              description: server,
              paths,
              childEnv,
              exec,
              execWithStdin,
              hashes,
              files,
              autoProbe,
              probeServers,
              timers: managedTimers,
              role,
              home: options.home,
              hostForms: endpointFormsOfSocket(own.sockets.gateway),
              readStopGraceMs,
              requestLimitMs: current.models.headersTimeoutMs,
              keySignal,
              incarnation: nextIncarnation(target.provider),
              generation: options.generation,
              userDialects,
              onWarning: (message) => logger.warn(message),
              ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
            });
            return { key: keys.core, ...built, closable: { close: (values) => built.managed.close(values) } };
          })());
        const { close: _stopsTheServer, ...serving } = core.managed;
        const adapter = createChatCompletionsAdapter({
          ...serving,
          capabilities: (adapterTarget) => serving.capabilities(adapterTarget, outputPolicy),
          authSource: unauthenticatedSource,
          sampling: SAMPLING_OF[server.sampling],
          clock,
          userDialects,
          liveness,
        });
        return {
          key: keys.part,
          adapter,
          counter: targetCounterOf({ target, server, codeDigest, outputPolicy, ...(core.probeKey === undefined ? {} : { probeKey: core.probeKey }) }),
          managed: core,
          closables: [adapterClosable(adapter), core.closable],
        };
      }
      if (target.adapter === 'ollama') {
        const probed = await createProbedOllamaAdapter(display, target, paths.probe, clock, userDialects, liveness, outbound, probes);
        return unmanagedPart(keys.part, probed.adapter, targetCounterOf({ target, codeDigest, outputPolicy, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) }));
      }
      const readKey = apiKeyReader(options.env, secretResolverOfPart(), target, handedCredential, keyReadLimitOf(current.models.headersTimeoutMs), timers);
      const identify = identificationOf(display, target, outbound);
      if (target.adapter === 'chat-completions' && target.toolCalling === 'auto') {
        const probed = await createAutoChatCompletionsAdapter(display, target, readKey, paths.probe, clock, identify, userDialects, liveness, outbound, probes);
        return unmanagedPart(keys.part, probed.adapter, targetCounterOf({ target, codeDigest, outputPolicy, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) }));
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
      const counter = targetCounterOf({ target, codeDigest, outputPolicy });
      switch (target.adapter) {
        case 'chat-completions':
          return unmanagedPart(keys.part, createChatCompletionsAdapter({ ...common, schemaDialect: () => resolveDialectId(target.capabilities.schemaDialect, null), authSource: authSourceOf(target, readKey) }), counter);
        case 'open-responses':
          return unmanagedPart(keys.part, createOpenResponsesAdapter({ ...common, authSource: authSourceOf(target, readKey) }), counter);
        case 'anthropic':
          return unmanagedPart(
            keys.part,
            createAnthropicAdapter({ ...common, apiVersion: target.apiVersion, authSource: authSourceOf(target, readKey) }),
            counter,
          );
      }
    };

    const buildPlanPart = (
      target: PlanTarget,
      current: ResolvedSettings,
      outbound: OutboundNetwork,
      key: string,
      { served, reported }: { served: ServedAccount; reported?: ReportedNumbers },
    ): TargetPart => {
      const source = served.account === null ? sessions.signedOutSource(served.profile) : sessions.authSource({ profile: served.profile, account: served.account });
      const auth = authSourceWithinRequestLimit(source, keyReadLimitOf(current.models.headersTimeoutMs), timers);
      const adapter = createPlanAdapter(target, auth, planProfiles, () => reported ?? undefined, {
        clock,
        userDialects: current.models.dialects,
        liveness: { headersTimeoutMs: current.models.headersTimeoutMs, idleTimeoutMs: current.models.idleTimeoutMs, timers },
        network: outbound,
      });
      return unmanagedPart(key, adapter, targetCounterOf({ target, codeDigest, served, ...(reported === undefined ? {} : { reported }) }));
    };

    const deriveEpoch = async (shared: GatewayEpochsShared, current: ResolvedSettings, previous: ProcessEpoch | undefined, keySignal: AbortSignal, inputs: EpochInputs): Promise<ProcessEpoch> => {
      const networkDigest = settingsInputsDigest(current.network ?? null);
      const outbound = previous !== undefined && previous.networkDigest === networkDigest ? previous.network : await outboundNetworkOf(current.network, keySignal);
      const shape = { userDialects: current.models.dialects, headersTimeoutMs: current.models.headersTimeoutMs, idleTimeoutMs: current.models.idleTimeoutMs };
      const outputPolicy: ProbeOutputPolicy = { unboundedOutputReserve: current.context.unboundedOutputReserve };
      const parts = new Map<string, TargetPart>();
      const built: Closable[] = [];
      try {
        const displays = displayMapOf(current.models.views);
        for (const [name, target] of current.models.models) {
          const display = displays.get(name) ?? name;
          const server = target.adapter === 'managed' ? requiredServer(current.models.servers, target.server) : null;
          const plan = 'plan' in target ? planComponentsOf(name, target, inputs) : undefined;
          const keys = {
            part: settingsInputsDigest({
              target,
              server,
              ...shape,
              network: target.adapter === 'managed' ? null : (current.network ?? null),
              ...(plan ?? {}),
              ...(readsOutputPolicy(target) ? { outputPolicy } : {}),
            }),
            core: settingsInputsDigest({ target, server, userDialects: shape.userDialects, requestLimitMs: shape.headersTimeoutMs }),
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
          const part =
            'plan' in target && plan !== undefined
              ? buildPlanPart(target, current, outbound, keys.part, plan)
              : await buildPart(display, target as ServedTarget, current, outbound, keySignal, carriedCore ?? livePartsOf[0], keys, outputPolicy);
          built.push(...part.closables.filter((closable) => !holds.has(closable)));
          parts.set(name, part);
        }
      } catch (error) {
        await Promise.all(built.map((closable) => closable.close(undefined)));
        throw error;
      }
      const counters = Object.fromEntries([...parts].map(([name, part]) => [name, part.counter]));
      const config = withCounters(gatewayConfigOf(current.models), counters);
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
      for (const credential of credentialValuesOf(options.env, credentialEnvNames(current.models), new Map(), (message) => logger.warn(message), outbound.config)) shared.redactor.add(credential);
      const priceTable = definePriceTable(current.pricing === undefined ? [] : current.pricing);
      const epoch: ProcessEpoch = {
        gateway: { router, priceTable, telemetry: undefined, planTargets: planTargetRefsOf(current) },
        priceTable,
        parts,
        network: outbound,
        networkDigest,
      };
      for (const closable of closablesOf(epoch)) hold(closable);
      liveEpochs.add(epoch);
      return epoch;
    };

    handedCredential = credentialFromSupervisor(own.sockets.supervisor, options.env[CREDENTIAL_CAPABILITY_ENV], (value) => shared.redactor.add(value));
    const derivation = createPinnedDerivation<ProcessEpoch>({
      cache,
      signal: lifetime.signal,
      inputsOf: epochInputsOf,
      prepare: preparePlan,
      derive: (current, previous, deriveSignal, inputs) => deriveEpoch(shared, current, previous, deriveSignal, inputs as EpochInputs),
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
    await role.refresh();
    const gateway = await createGateway({
      startSignal,
      limits: GATEWAY_CONFIG_DEFAULTS,
      epochs,
      ...shared,
      role,
      probeFlights: () => autoProbe.openFlights(),
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
      traceContent: async (runId, after, limit, requestSignal) => {
        await flushTelemetry(requestSignal);
        return pageRunBodies(traceStore, runId, after, limit);
      },
      version: options.version,
      onError: (error) => logger.error('unhandled gateway error', { err: toError(error) }),
      onFatal: latchFatal,
      plan: planApi,
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

    const runtimeHealth = options.runtimeHealth ?? runtimeHealthOver(own.sockets.runtime);
    const requestShutdown = options.requestShutdown ?? ((): void => void close());
    let tickFailure: string | undefined;
    const reportTickFailure = (error: unknown): void => {
      const reason = toError(error).message;
      if (reason === tickFailure) return;
      tickFailure = reason;
      logger.warn('generation.tick_failed', { err: toError(error) });
    };
    const holdsNothing = (): boolean => gateway.activeRequests() === 0;
    const leaveWhenUnheld = async (): Promise<void> => {
      gateway.releaseIdleConnections();
      if (retired || !holdsNothing()) return;
      const standing = await runtimeHealth(AbortSignal.any([lifetime.signal, AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS)]));
      if (standing === 'busy' || phase !== 'running' || role.current() !== 'retiring' || !holdsNothing()) return;
      retired = true;
      logger.info('generation.retired', { data: { generation: options.generation } });
      requestShutdown();
    };
    const tick = async (): Promise<void> => {
      try {
        await role.refresh();
        if (phase === 'running' && role.current() === 'retiring') await leaveWhenUnheld();
        tickFailure = undefined;
      } catch (error) {
        if (!lifetime.signal.aborted) reportTickFailure(error);
      }
    };
    let tickTimer: unknown;
    const armTick = (): void => {
      tickTimer = timers.setTimeout(() => {
        void tick().then(() => {
          if (phase === 'running') armTick();
        });
      }, SWEEP_INTERVAL_MS);
    };
    cleanups.push(() => timers.clearTimeout(tickTimer));
    armTick();

    return { ready, socketPath: gateway.socketPath, close, abort, role: () => role.current(), fatal };
  } catch (error) {
    phase = 'closing';
    for (const cleanupFailure of await unwind()) logger.error('startup.cleanup_failed', { err: cleanupFailure });
    phase = 'closed';
    throw error;
  }
};
