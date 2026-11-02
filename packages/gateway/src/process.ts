import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { credentialEnvNames, loadUserSettings, secretNames } from '@momonga/config';
import {
  acquireProcessLock,
  SecretEmptyError,
  SecretUnavailableError,
  announceReady,
  createJsonLogger,
  createKeychainSecretStore,
  ensureMomongaDirs,
  minimalChildEnv,
  momongaPaths,
  secretKeyFile,
  systemClock,
} from '@momonga/foundation';
import type { Clock, JsonLogger, MomongaPaths, ReadyFields, SecretStore, TextStream } from '@momonga/foundation';
import { closeTelemetry, createTelemetry, openTraceStore } from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import type { AdapterTarget, Capabilities, ProviderAdapter } from '@momonga/protocol';
import { createAnthropicAdapter } from './adapters/anthropic/adapter.ts';
import { createChatCompletionsAdapter } from './adapters/chat-completions/adapter.ts';
import { createOpenResponsesAdapter } from './adapters/open-responses/adapter.ts';
import type { UpstreamEndpoint } from './adapters/shared/http-client.ts';
import { FM_SERVE_DEFAULTS, GATEWAY_CONFIG_DEFAULTS } from './defaults.ts';
import { missingApiKeyError, secretUnavailableError } from './core/errors.ts';
import { MIN_CREDENTIAL_CHARS } from './core/redaction.ts';
import { FmServeError, createFmServe } from './managed/fm-serve.ts';
import type { ExecFn, FmServe, SpawnFn } from './managed/fm-serve.ts';
import { createExecFn, createExecWithStdin } from './managed/fm-processes.ts';
import { createManagedFmTarget } from './managed/fm-target.ts';
import type { ExecWithStdinFn, ManagedFmTarget } from './managed/fm-target.ts';
import { createGateway } from './server/gateway.ts';
import type { GatewayConfig, GatewayTimers } from './types.ts';

export type StartGatewayProcessOptions = {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  clock?: Clock;
  timers?: GatewayTimers;
  fmBinary?: string;
  exec?: ExecFn;
  execWithStdin?: ExecWithStdinFn;
  secretStore?: SecretStore;
  spawn?: SpawnFn;
  logger?: JsonLogger;
  stdout?: TextStream;
  signal?: AbortSignal;
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
const OS_BUILD_COMMAND = '/usr/bin/sw_vers';

type ResolvedTargets = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'];
type ResolvedTarget = ResolvedTargets[string];
type RemoteTarget = Exclude<ResolvedTarget, { adapter: 'fm' }>;

const realTimers: GatewayTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const sha256OfFile = async (file: string): Promise<string> => {
  try {
    return createHash('sha256')
      .update(await fs.promises.readFile(file))
      .digest('hex');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return '';
    throw error;
  }
};

const binaryUsable = async (file: string): Promise<boolean> => {
  try {
    await fs.promises.access(file, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return false;
    throw error;
  }
};

const withBinaryGuard = (managed: ManagedFmTarget, binary: string): ManagedFmTarget => {
  const detail = `fm binary not found at ${binary}`;
  return {
    ...managed,
    resolveEndpoint: async (target) => {
      if (!(await binaryUsable(binary))) {
        throw new FmServeError('precondition_failed', 'fm preconditions are not satisfied', detail, undefined);
      }
      return managed.resolveEndpoint(target);
    },
    health: async (target) =>
      (await binaryUsable(binary)) ? managed.health(target) : { ok: false, reason: 'precondition_failed', detail },
  };
};

const endpointOf = (target: RemoteTarget): UpstreamEndpoint => {
  if (target.socketPath !== undefined) return { kind: 'unix', socketPath: target.socketPath };
  if (target.baseUrl !== undefined) return { kind: 'tcp', baseUrl: target.baseUrl };
  throw new Error(`${target.adapter} target has neither socketPath nor baseUrl`);
};

const capabilitiesOf = (target: RemoteTarget): Capabilities => ({ ...target.capabilities, toolCalling: target.toolCalling });

type ResolvedSecrets = { values: ReadonlyMap<string, string>; failures: ReadonlyMap<string, Error> };

const resolveSecrets = async (store: SecretStore, names: readonly string[], signal: AbortSignal): Promise<ResolvedSecrets> => {
  const values = new Map<string, string>();
  const failures = new Map<string, Error>();
  for (const name of names) {
    try {
      values.set(name, await store.read(name, signal));
    } catch (error) {
      if (!(error instanceof SecretUnavailableError || error instanceof SecretEmptyError)) throw error;
      failures.set(name, error);
    }
  }
  return { values, failures };
};

const apiKeyReader = (
  env: StartGatewayProcessOptions['env'],
  secrets: ResolvedSecrets,
  target: Pick<RemoteTarget, 'apiKeyEnv' | 'apiKeySecret'>,
): ((target: AdapterTarget) => Promise<string | undefined>) => {
  const { apiKeyEnv, apiKeySecret } = target;
  return async (_target) => {
    if (apiKeySecret !== undefined) {
      const failure = secrets.failures.get(apiKeySecret);
      if (failure !== undefined) throw secretUnavailableError(apiKeySecret, failure);
      const value = secrets.values.get(apiKeySecret);
      if (value === undefined) throw new Error(`the secret "${apiKeySecret}" was not resolved at startup`);
      return value;
    }
    if (apiKeyEnv === undefined) return undefined;
    const value = env[apiKeyEnv];
    if (value === undefined || value === '') throw missingApiKeyError(apiKeyEnv);
    return value;
  };
};

const requiredKey = async (read: ReturnType<typeof apiKeyReader>, target: AdapterTarget): Promise<string> => {
  const key = await read(target);
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

const createFmAdapter = async (name: string, target: Extract<ResolvedTarget, { adapter: 'fm' }>, context: FmContext, clock: Clock) => {
  const managed = await createManagedFmTarget({
    fmServe: context.fmServe,
    binary: context.binary,
    exec: context.execWithStdin,
    probeRecordDir: context.paths.probe,
    recordKey: { target: name, binarySha256: context.binarySha256, osBuild: context.osBuild },
    toolCallingSetting: target.toolCalling,
  });
  return createChatCompletionsAdapter({ ...withBinaryGuard(managed, context.binary), clock });
};

const readOsBuild = async (exec: ExecFn): Promise<string> => {
  const result = await exec(OS_BUILD_COMMAND, ['-buildVersion']);
  if (result.exitCode !== 0) throw new Error(`sw_vers -buildVersion exited with ${result.exitCode}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const gatewayConfigOf = (targets: ResolvedTargets, aliases: Record<string, string | string[]>): GatewayConfig => ({
  models: {
    aliases: Object.fromEntries(Object.entries(aliases).map(([alias, members]) => [alias, [members].flat()])),
    targets: Object.fromEntries(
      Object.entries(targets).map(([name, target]) => [
        name,
        { kind: target.adapter, model: target.model, maxConcurrency: target.maxConcurrency, admissionTimeoutMs: target.admissionTimeoutMs },
      ]),
    ),
  },
  ...GATEWAY_CONFIG_DEFAULTS,
});

export const startGatewayProcess = async (options: StartGatewayProcessOptions): Promise<GatewayProcess> => {
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? realTimers;
  const logger = options.logger ?? createJsonLogger({ service: 'gateway', clock });
  const binary = options.fmBinary ?? DEFAULT_FM_BINARY;
  const { signal } = options;
  const stdout = options.stdout ?? process.stdout;
  const paths = momongaPaths(options.home, process.platform, {});
  signal?.throwIfAborted();
  await ensureMomongaDirs(paths);
  signal?.throwIfAborted();
  const lock = await acquireProcessLock(paths.locks.gateway);
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
      mustExist: fs.existsSync(paths.databases.gateway),
      dependentPath: paths.databases.gateway,
    });
    const traceStore: TraceStore = openTraceStore({ path: paths.traces.gateway, clock });
    const telemetry: Telemetry = createTelemetry({ serviceName: 'momonga-gateway', serviceVersion: options.version, clock, store: traceStore });
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
              socketPath: paths.sockets.fm,
              env: childEnv,
              markerDirectory: paths.markers.fm,
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
    const referencedSecrets = secretNames(settings);
    const secretStore =
      options.secretStore ?? createKeychainSecretStore(options.execWithStdin ?? createExecWithStdin(childEnv));
    const secrets =
      referencedSecrets.length === 0
        ? { values: new Map<string, string>(), failures: new Map<string, Error>() }
        : await resolveSecrets(secretStore, referencedSecrets, signal ?? new AbortController().signal);
    for (const [name, failure] of secrets.failures) logger.warn(`secret ${name} is unavailable: ${failure.message}`);
    signal?.throwIfAborted();
    for (const [name, target] of targets) {
      signal?.throwIfAborted();
      if (target.adapter === 'fm') {
        if (fmContext === undefined) throw new Error('fm context is missing for an fm target');
        adapters[name] = await createFmAdapter(name, target, fmContext, clock);
        continue;
      }
      const readKey = apiKeyReader(options.env, secrets, target);
      const common = { resolveEndpoint: async () => endpointOf(target), capabilities: async () => capabilitiesOf(target), clock };
      switch (target.adapter) {
        case 'chat-completions':
          adapters[name] = createChatCompletionsAdapter({ ...common, toolCalling: () => target.toolCalling, apiKey: readKey });
          break;
        case 'open-responses':
          adapters[name] = createOpenResponsesAdapter({ ...common, apiKey: readKey });
          break;
        case 'anthropic':
          adapters[name] = createAnthropicAdapter({ ...common, apiKey: (adapterTarget) => requiredKey(readKey, adapterTarget) });
          break;
      }
    }

    signal?.throwIfAborted();
    const gateway = await createGateway({
      config: gatewayConfigOf(settings.models.targets, settings.models.aliases),
      adapters,
      credentials: credentialValuesOf(options.env, credentialEnvNames(settings), secrets.values, (message) => logger.warn(message)),
      clock,
      timers,
      dbPath: paths.databases.gateway,
      hmacKey,
      socketPath: paths.sockets.gateway,
      telemetry,
      version: options.version,
      onError: (error) => logger.error('unhandled gateway error', { err: toError(error) }),
      onFatal: latchFatal,
    });
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
