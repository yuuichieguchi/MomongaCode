import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { loadUserSettings } from '@momonga/config';
import {
  acquireProcessLock,
  announceReady,
  createJsonLogger,
  ensureMomongaDirs,
  momongaPaths,
  secretKeyFile,
  systemClock,
} from '@momonga/foundation';
import type { Clock, JsonLogger, MomongaPaths } from '@momonga/foundation';
import { closeTelemetry, createTelemetry, openTraceStore } from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import type { AdapterTarget, Capabilities, ProviderAdapter } from '@momonga/protocol';
import { createChatCompletionsAdapter } from './adapters/chat-completions/adapter.ts';
import type { ChatCompletionsEndpoint } from './adapters/chat-completions/types.ts';
import { FM_SERVE_DEFAULTS, GATEWAY_CONFIG_DEFAULTS } from './defaults.ts';
import { missingApiKeyError } from './core/errors.ts';
import { FmServeError, createFmServe } from './managed/fm-serve.ts';
import type { ExecFn, FmServe, SpawnFn } from './managed/fm-serve.ts';
import { createExecFn, createExecWithStdin, minimalChildEnv } from './managed/fm-processes.ts';
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
  spawn?: SpawnFn;
  logger?: JsonLogger;
};

export type GatewayProcess = { socketPath: string; close(): Promise<void> };

const DEFAULT_FM_BINARY = '/usr/bin/fm';
const OS_BUILD_COMMAND = '/usr/bin/sw_vers';

type ResolvedTargets = Awaited<ReturnType<typeof loadUserSettings>>['settings']['models']['targets'];
type ResolvedTarget = ResolvedTargets[string];
type ChatCompletionsTarget = Extract<ResolvedTarget, { adapter: 'chat-completions' }>;

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

const endpointOf = (target: ChatCompletionsTarget): ChatCompletionsEndpoint => {
  if (target.socketPath !== undefined) return { kind: 'unix', socketPath: target.socketPath };
  if (target.baseUrl !== undefined) return { kind: 'tcp', baseUrl: target.baseUrl };
  throw new Error('chat-completions target has neither socketPath nor baseUrl');
};

const capabilitiesOf = (target: ChatCompletionsTarget): Capabilities => ({ ...target.capabilities, toolCalling: target.toolCalling });

const apiKeyReader =
  (env: StartGatewayProcessOptions['env'], apiKeyEnv: string | undefined) =>
  (_target: AdapterTarget): string | undefined => {
    if (apiKeyEnv === undefined) return undefined;
    const value = env[apiKeyEnv];
    if (value === undefined || value === '') throw missingApiKeyError(apiKeyEnv);
    return value;
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
  const paths = momongaPaths(options.home, process.platform, {});
  await ensureMomongaDirs(paths);
  const lock = await acquireProcessLock(paths.locks.gateway);
  const cleanups: Array<() => void | Promise<void>> = [() => lock.release()];
  const unwind = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'gateway process cleanup failed');
  };
  try {
    const { settings, warnings } = await loadUserSettings({ home: options.home });
    for (const warning of warnings) logger.warn(warning);
    const hmacKey = secretKeyFile(paths.gatewayKey, {
      mustExist: fs.existsSync(paths.databases.gateway),
      dependentPath: paths.databases.gateway,
    });
    const traceStore: TraceStore = openTraceStore({ path: paths.traces.gateway, clock });
    const telemetry: Telemetry = createTelemetry({ serviceName: 'momonga-gateway', serviceVersion: options.version, clock, store: traceStore });
    cleanups.push(() => closeTelemetry(telemetry, traceStore));

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
    for (const [name, target] of targets) {
      if (target.adapter === 'fm') {
        if (fmContext === undefined) throw new Error('fm context is missing for an fm target');
        adapters[name] = await createFmAdapter(name, target, fmContext, clock);
      } else {
        adapters[name] = createChatCompletionsAdapter({
          resolveEndpoint: async () => endpointOf(target),
          toolCalling: () => target.toolCalling,
          capabilities: async () => capabilitiesOf(target),
          apiKey: apiKeyReader(options.env, target.apiKeyEnv),
          clock,
        });
      }
    }

    const gateway = await createGateway({
      config: gatewayConfigOf(settings.models.targets, settings.models.aliases),
      adapters,
      clock,
      timers,
      dbPath: paths.databases.gateway,
      hmacKey,
      socketPath: paths.sockets.gateway,
      telemetry,
      version: options.version,
      onError: (error) => logger.error('unhandled gateway error', { err: error instanceof Error ? error : new Error(String(error)) }),
    });
    cleanups.splice(cleanups.indexOf(closeAdapters), 1);
    cleanups.push(() => gateway.close());
    announceReady({ service: 'gateway', pid: process.pid, version: options.version, socketPath: gateway.socketPath, startedAt: gateway.startedAt });

    let closing: Promise<void> | undefined;
    return {
      socketPath: gateway.socketPath,
      close: () => {
        closing ??= unwind();
        return closing;
      },
    };
  } catch (error) {
    await unwind().catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], 'gateway process startup failed and cleanup failed');
    });
    throw error;
  }
};
