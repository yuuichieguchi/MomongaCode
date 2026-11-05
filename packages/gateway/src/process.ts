import path from 'node:path';
import { credentialEnvNames, loadUserSettings, probeRecordKeyOf, secretNames, upstreamEndpointOf } from '@momonga/config';
import {
  acquireProcessLock,
  SecretEmptyError,
  SecretUnavailableError,
  announceReady,
  createJsonLogger,
  createPlatformSecretStore,
  EntryUsageError,
  ensureMomongaDirs,
  minimalChildEnv,
  adapterSocketPath,
  codeDigestOfRunningProcess,
  momongaPaths,
  secretKeyFile,
} from '@momonga/foundation';
import type { EndpointProbeKey } from '@momonga/config';
import type { Clock, JsonLogger, MomongaPaths, ProcessLock, ReadyFields, SecretStore, TextStream } from '@momonga/foundation';
import {
  buildCostReport,
  closeTelemetry,
  definePriceTable,
  formatCostReport,
  createTelemetry,
  exportersFor,
  openTraceStore,
  pageBilledCalls,
} from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import type { AdapterTarget, Capabilities, ProviderAdapter, ToolCallingMode } from '@momonga/protocol';
import { chatRecordOf, loadEndpointRecord, ollamaRecordOf, saveEndpointRecord } from './probe/endpoint-record.ts';
import type { DeclaredCapabilities } from './probe/decide.ts';
import { withImageDefault } from './probe/decide.ts';
import { createProbedEndpointTarget, endpointKeyOf, ollamaServerRefusal, probeEndpointOf, readEndpointIdentity } from './probe/endpoint-target.ts';
import { answersAsOllama, readOllamaDigest } from './probe/ollama.ts';
import { createProbedOllamaTarget } from './probe/ollama-target.ts';
import { createSecretResolver } from './secrets.ts';
import { targetCounterOf } from './target-counter.ts';
import type { SecretResolver } from './secrets.ts';
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
import type { ExecFn, FmServe, SpawnFn } from './managed/fm-serve.ts';
import { createExecFn, createExecWithStdin } from './managed/fm-processes.ts';
import { readOsBuild, sha256OfFile } from './managed/fm-record-key.ts';
import { createManagedFmTarget } from './managed/fm-target.ts';
import type { ExecWithStdinFn, ManagedFmTarget } from './managed/fm-target.ts';
import { createGateway } from './server/gateway.ts';
import { systemProcessPorts } from './process-ports.ts';
import type { ProcessFilePorts } from './process-ports.ts';
import type { GatewayConfig, GatewayTimers } from './types.ts';

export type StartGatewayProcessOptions = {
  home: string;
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
  close(): Promise<GatewayCloseResult>;
  abort(): Promise<GatewayCloseResult>;
  fatal: Promise<Error>;
};

type Phase = 'starting' | 'running' | 'closing' | 'closed';

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const failuresOf = (error: unknown): Error[] => (error instanceof AggregateError ? error.errors.map(toError) : [toError(error)]);

const DEFAULT_FM_BINARY = '/usr/bin/fm';

type ResolvedTargets = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'];
type ResolvedTarget = ResolvedTargets[string];
type RemoteTarget = Exclude<ResolvedTarget, { adapter: 'fm' }>;
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
): string[] => {
  const labelled: Array<[string, string | undefined]> = [
    ...envNames.map((name): [string, string | undefined] => [name, env[name]]),
    ...[...secretValues].map(([name, value]): [string, string | undefined] => [`secret ${name}`, value]),
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
  binarySha256: string;
};

const createFmAdapter = async (name: string, target: Extract<ResolvedTarget, { adapter: 'fm' }>, context: FmContext, clock: Clock, files: ProcessFilePorts) => {
  const managed = await createManagedFmTarget({
    fmServe: context.fmServe,
    binary: context.binary,
    exec: context.execWithStdin,
    probeRecordDir: context.paths.probe,
    recordKey: { target: name, binarySha256: context.binarySha256, osBuild: context.osBuild },
    toolCallingSetting: target.toolCalling,
    ...(target.model === undefined ? {} : { declaredModel: target.model }),
    ...(target.outputBoundField === undefined ? {} : { declaredOutputBoundField: target.outputBoundField }),
  });
  return createChatCompletionsAdapter({ ...withBinaryGuard(managed, context.binary, files), clock });
};

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
  refusal: PreconditionFailedError | undefined,
) => {
  const upstream = upstreamEndpointOf(target);
  const key = endpointProbeKeyOf(name, target);
  const { endpoint } = key;
  const loaded = chatRecordOf(await loadEndpointRecord(probeRecordDir, key), key);
  const probed = createProbedEndpointTarget({
    targetName: name,
    endpoint,
    model: target.model,
    declared: declaredCapabilitiesOf(target, 'native'),
    record: loaded,
    readIdentity: async (fields, signal) => {
      const apiKey = await readKey({ name, model: target.model }, signal);
      return readEndpointIdentity(probeEndpointOf(upstream, apiKey), target.model, fields, signal);
    },
    saveRecord: (record) =>
      saveEndpointRecord(probeRecordDir, key, record.identity, record.identityFields, record.report),
  });
  const adapter = createChatCompletionsAdapter({
    resolveEndpoint: async (_target, signal) => {
      if (refusal !== undefined) throw refusal;
      await probed.verify(signal);
      return upstream;
    },
    toolCalling: () => probed.toolCalling(),
    keywordSupport: () => probed.keywordSupport(),
    capabilities: () => probed.capabilities(),
    onSummaryReasoning: (_target, hiddenReasoningTokens) => probed.raiseHeadroom(hiddenReasoningTokens),
    apiKey: readKey,
    clock,
  });
  return { adapter, upstreamIdentity: loaded?.identity };
};

const createProbedOllamaAdapter = async (name: string, target: Extract<RemoteTarget, { adapter: 'ollama' }>, probeRecordDir: string, clock: Clock) => {
  const upstream = upstreamEndpointOf(target);
  const key = endpointProbeKeyOf(name, target);
  const { endpoint } = key;
  const loaded = ollamaRecordOf(await loadEndpointRecord(probeRecordDir, key), key);
  const probed = createProbedOllamaTarget({
    targetName: name,
    endpoint,
    model: target.model,
    declared: declaredCapabilitiesOf(target, 'native'),
    record: loaded,
    readDigest: (signal) => readOllamaDigest(upstream, target.model, signal),
  });
  const adapter = createOllamaAdapter({
    resolveEndpoint: async (_target, signal) => {
      await probed.verify(signal);
      return upstream;
    },
    capabilities: () => probed.capabilities(),
    clock,
  });
  return { adapter, upstreamIdentity: loaded?.identity };
};

const ollamaRefusalsOf = async (targets: ReadonlyArray<readonly [string, ResolvedTarget]>, signal: AbortSignal): Promise<Map<string, PreconditionFailedError>> => {
  const candidates = targets.filter((entry): entry is readonly [string, OllamaDetectable] => {
    const [, target] = entry;
    return (target.adapter === 'chat-completions' || target.adapter === 'open-responses') && target.baseUrl !== undefined;
  });
  const answers = await Promise.all(candidates.map(async ([, target]) => answersAsOllama(upstreamEndpointOf(target), signal)));
  return new Map(
    candidates.flatMap(([name, target], index) => (answers[index] === true ? [[name, ollamaServerRefusal(name, target.adapter, endpointKeyOf(upstreamEndpointOf(target)))] as const] : [])),
  );
};

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
  await ensureMomongaDirs(paths);
  signal?.throwIfAborted();
  const lock = await (options.acquireLock ?? acquireProcessLock)(paths.locks.gateway);
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

  const shutdown = async (): Promise<GatewayCloseResult> => {
    phase = 'closing';
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

  const close = (): Promise<GatewayCloseResult> => {
    lifecycle ??= shutdown();
    return lifecycle;
  };

  const abort = (): Promise<GatewayCloseResult> => {
    abortRequested = true;
    if (lifecycle === undefined) lifecycle = shutdown();
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
    signal?.throwIfAborted();
    const hmacKey = secretKeyFile(paths.gatewayKey, {
      mustExist: files.databaseExists(paths.databases.gateway),
      dependentPath: paths.databases.gateway,
    });
    const priceTable = definePriceTable(settings.pricing === undefined ? [] : settings.pricing);
    const traceStore: TraceStore = openTraceStore({ path: paths.traces.gateway, clock });
    const telemetry: Telemetry = createTelemetry({
      serviceName: 'momonga-gateway',
      serviceVersion: options.version,
      clock,
      store: traceStore,
      exporters: exportersFor(settings.telemetry),
      captureMessageContent: settings.telemetry?.captureMessageContent === true,
    });
    cleanups.push(() => closeTelemetry(telemetry, traceStore));

    signal?.throwIfAborted();
    const childEnv = minimalChildEnv(options.env);
    const exec = options.exec ?? createExecFn(childEnv);
    const targets = Object.entries(settings.models.targets);
    const adapters: Record<string, ProviderAdapter> = {};
    const closeAdapters = async (): Promise<void> => {
      await Promise.all(Object.values(adapters).map((adapter) => adapter.close?.()));
    };
    cleanups.push(closeAdapters);

    const fmTargets = targets.filter(([, target]) => target.adapter === 'fm');
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
              onWarning: (message) => logger.warn(message),
              exec,
              ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
              timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => clock.now() },
            }),
            execWithStdin: options.execWithStdin ?? createExecWithStdin(childEnv),
            osBuild: await readOsBuild(exec),
            binarySha256: await sha256OfFile(binary),
          };
    signal?.throwIfAborted();
    const codeDigest = await codeDigestOfRunningProcess();
    const counters: Record<string, string> = {};
    const referencedSecrets = secretNames(settings);
    const secretStore =
      options.secretStore ?? createPlatformSecretStore(process.platform, options.execWithStdin ?? createExecWithStdin(childEnv), childEnv);
    const secretResolver = createSecretResolver(secretStore);
    const secretFailures = await warmSecrets(secretResolver, referencedSecrets, signal ?? new AbortController().signal);
    for (const [name, failure] of secretFailures) logger.warn(`secret ${name} is unavailable: ${failure.message}`);
    signal?.throwIfAborted();
    const ollamaRefusals = await ollamaRefusalsOf(targets, signal ?? new AbortController().signal);
    signal?.throwIfAborted();
    for (const [name, target] of targets) {
      signal?.throwIfAborted();
      if (target.adapter === 'fm') {
        if (fmContext === undefined) throw new Error('fm context is missing for an fm target');
        adapters[name] = await createFmAdapter(name, target, fmContext, clock, files);
        counters[name] = targetCounterOf({ target, codeDigest, fm: { binarySha256: fmContext.binarySha256, osBuild: fmContext.osBuild } });
        continue;
      }
      if (target.adapter === 'ollama') {
        const probed = await createProbedOllamaAdapter(name, target, paths.probe, clock);
        adapters[name] = probed.adapter;
        counters[name] = targetCounterOf({ target, codeDigest, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) });
        continue;
      }
      const readKey = apiKeyReader(options.env, secretResolver, target);
      const refusal = ollamaRefusals.get(name);
      if (target.adapter === 'chat-completions' && target.toolCalling === 'auto') {
        const probed = await createAutoChatCompletionsAdapter(name, target, readKey, paths.probe, clock, refusal);
        adapters[name] = probed.adapter;
        counters[name] = targetCounterOf({ target, codeDigest, ...(probed.upstreamIdentity === undefined ? {} : { upstreamIdentity: probed.upstreamIdentity }) });
        continue;
      }
      counters[name] = targetCounterOf({ target, codeDigest });
      const mode: ToolCallingMode = target.toolCalling === 'auto' ? 'native' : target.toolCalling;
      const common = {
        resolveEndpoint: async () => {
          if (refusal !== undefined) throw refusal;
          return upstreamEndpointOf(target);
        },
        capabilities: async () => capabilitiesOf(target, mode),
        clock,
      };
      switch (target.adapter) {
        case 'chat-completions':
          adapters[name] = createChatCompletionsAdapter({ ...common, toolCalling: () => mode, apiKey: readKey });
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
      credentials: credentialValuesOf(options.env, credentialEnvNames(settings), secretResolver.resolved(), (message) => logger.warn(message)),
      credentialFeed: (add) =>
        secretResolver.onResolved((name, value) => {
          for (const credential of credentialValuesOf({}, [], new Map([[name, value]]), (message) => logger.warn(message))) add(credential);
        }),
      clock,
      timers,
      random,
      dbPath: paths.databases.gateway,
      hmacKey,
      socketPath: paths.sockets.gateway,
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
    cleanups.push(() => (abortRequested ? gateway.abort() : gateway.close()));
    requestGatewayAbort = () => void gateway.abort();
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
