import { declaredChildEnv, minimalChildEnv, probeKeyComponentLabel, readProbeKeyComponents } from '@momonga/foundation';
import type { BinaryHashCache, ChildLaunch, FileSystemSync, HeldHostReadings, ManagedInstancePaths, MomongaPaths, KernelLockMechanism, ProcessInspector, Random } from '@momonga/foundation';
import { knownKeyOf, managedServerDigest, probeKeyOf } from '@momonga/config';
import type { ProbeKey } from '@momonga/config';
import { WORDS } from '@momonga/protocol';
import type { DialectId, ManagedServerDescription, ProbeReport, ToolCallingMode } from '@momonga/protocol';
import { NO_USER_DIALECTS } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import { vocabularyOf } from '../adapters/chat-completions/vocabulary.ts';
import { createExecFn, createExecWithStdin } from '../managed/fm-processes.ts';
import { createManagedServer } from '../managed/server.ts';
import type { ManagedServer, ManagedServerTimers, SpawnFn } from '../managed/server.ts';
import { missingExecutableVerdict, runPreconditions } from '../managed/preconditions.ts';
import type { ExecFn } from '../managed/preconditions.ts';
import { parseCount } from '../managed/target.ts';
import type { ExecWithStdinFn } from '../managed/target.ts';
import { decideToolCalling } from './decide.ts';
import { recordProbe, targetNotReadyError } from './auto-probe.ts';
import { measuringAskOf } from './sources.ts';
import type { MeasureProbe, ProbeLockKey, ProbePrecondition, ProbeSubject } from './auto-probe.ts';
import { managedRecordPath, saveProbeRecord } from './record.ts';
import type { ManagedRecordCurrency } from './record.ts';
import { DEFAULT_STEP_TIMEOUT_MS, PROBE_METHOD_VERSION, runProbe } from './run-probe.ts';
import { createProbeClient, fixedStepBound } from './client.ts';
import { PERSON_TRAFFIC } from './request-gate.ts';
import type { RequestGate } from './request-gate.ts';
import { parseExternalJson } from '../adapters/shared/json.ts';
import { valueAtPath } from './reply.ts';

export const MANAGED_CHILD_ENV_NAMES: readonly string[] = [];

export const managedChildEnvOf = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => ({ ...minimalChildEnv(env), ...declaredChildEnv(env, MANAGED_CHILD_ENV_NAMES) });

export type ManagedKeyReaderOptions = {
  description: ManagedServerDescription;
  binary: string;
  model: string;
  exec: ExecFn;
  platform: NodeJS.Platform;
  hashes: BinaryHashCache;
  host?: HeldHostReadings;
};

export const managedKeyReader =
  (options: ManagedKeyReaderOptions) =>
  async (signal: AbortSignal): Promise<ProbeKey> =>
    probeKeyOf({
      subject: options.description.id,
      identity: options.description.identity,
      readings: await readProbeKeyComponents({ identity: options.description.identity, binary: options.binary, platform: options.platform, exec: options.exec, signal, hashes: options.hashes, ...(options.host === undefined ? {} : { host: options.host }) }),
      model: options.model,
    });

export const lockKeyOf = (key: Extract<ProbeKey, { kind: 'known' }>): ProbeLockKey => key.fields;

export const managedCurrencyOf = (description: ManagedServerDescription, options: { userDialects?: UserDialects; declaredDialect?: DialectId }): ManagedRecordCurrency => ({
  userDialects: options.userDialects ?? NO_USER_DIALECTS,
  probeMethod: PROBE_METHOD_VERSION,
  ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
  descriptionDigest: managedServerDigest(description),
});

export type MeasureManagedServerOptions = {
  description: ManagedServerDescription;
  target: string;
  binary: string;
  instance: ManagedInstancePaths;
  lock: KernelLockMechanism;
  inspector: ProcessInspector;
  random: Random;
  fileSystem: FileSystemSync;
  readyTimeoutMs: number;
  env: Readonly<Record<string, string>>;
  exec: ExecFn;
  execWithStdin: ExecWithStdinFn;
  gate: RequestGate;
  model: string;
  samples?: number;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  servers?: Set<ManagedServer>;
  launch: ChildLaunch;
  spawn?: SpawnFn;
  timers: ManagedServerTimers;
  stepTimeoutMs?: number;
  readStopGraceMs: () => number;
  onWarning(message: string): void;
};

type ManagedServerRunOptions = Pick<
  MeasureManagedServerOptions,
  'description' | 'target' | 'binary' | 'instance' | 'lock' | 'inspector' | 'random' | 'fileSystem' | 'readyTimeoutMs' | 'env' | 'exec' | 'readStopGraceMs' | 'onWarning' | 'launch' | 'spawn' | 'timers' | 'servers'
>;

const onManagedServer = async <T>(options: ManagedServerRunOptions, signal: AbortSignal, use: (socketPath: string) => Promise<T>): Promise<T> => {
  const { description } = options;
  const server = createManagedServer({
    description,
    target: options.target,
    binary: options.binary,
    socketPath: options.instance.socketPath,
    lockPath: options.instance.lockPath,
    lock: options.lock,
    inspector: options.inspector,
    random: options.random,
    fileSystem: options.fileSystem,
    markerDirectory: options.instance.markerDirectory,
    readyTimeoutMs: options.readyTimeoutMs,
    env: options.env,
    exec: options.exec,
    readStopGraceMs: options.readStopGraceMs,
    onWarning: options.onWarning,
    launch: options.launch,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    timers: options.timers,
  });
  options.servers?.add(server);
  try {
    const endpoint = await server.start(signal);
    return await use(endpoint.path);
  } finally {
    await server.stop({ stopGraceMs: options.readStopGraceMs() });
    options.servers?.delete(server);
  }
};

export const measureManagedServer =
  (options: MeasureManagedServerOptions): MeasureProbe<ProbeLockKey, ProbeReport> =>
  ({ signal, progress }) => {
    const { description } = options;
    const { tokenCount } = description;
    return onManagedServer(options, signal, (socketPath) =>
      runProbe({
        socketPath,
        managed: { readyPath: description.ready.path, listPath: description.models.listPath, idPath: description.models.idPath },
        vocabulary: vocabularyOf(description),
        ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
        ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
        model: options.model,
        ...(tokenCount === 'estimated' ? {} : { countTokens: async (text: string) => parseCount(options.target, await options.execWithStdin(options.binary, tokenCount.argv, text, signal)) }),
        ...(options.samples === undefined ? {} : { samples: options.samples }),
        ports: { clock: options.timers, timers: options.timers, gate: options.gate },
        progress,
        ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
        signal,
      }),
    );
  };

export const managedPrecondition = (description: ManagedServerDescription, target: string, binary: string, exec: ExecFn, isUsableBinary: (binary: string) => Promise<boolean>, boundMs: number): ProbePrecondition => ({
  boundMs,
  check: async (signal) => ((await isUsableBinary(binary)) ? runPreconditions(description, binary, exec, signal) : missingExecutableVerdict(target, binary)),
});

export type ManagedProbeSubjectOptions = {
  target: string;
  precondition: ProbePrecondition;
  probeRecordDir: string;
  lock: KernelLockMechanism;
  readKey: (signal: AbortSignal) => Promise<ProbeKey>;
  keySignal: () => AbortSignal;
  measure: MeasureProbe<ProbeLockKey, ProbeReport>;
  currency: ManagedRecordCurrency;
};

export class UnreadableProbeKeyError extends Error {
  constructor(target: string, component: string, reason: string) {
    super(`the model "${target}" is not ready: its probe key needs the ${probeKeyComponentLabel(component)}, which cannot be read: ${reason}`);
    this.name = 'UnreadableProbeKeyError';
  }
}

export const managedProbeSubject = (options: ManagedProbeSubjectOptions): ProbeSubject<ProbeLockKey, ProbeReport> => ({
  target: options.target,
  unknown: measuringAskOf(options.target, ['toolCalling']),
  readKey: async () => {
    const key = await options.readKey(options.keySignal());
    if (key.kind === 'unknown') throw new UnreadableProbeKeyError(options.target, key.component, key.reason);
    return lockKeyOf(key);
  },
  precondition: options.precondition,
  measure: options.measure,
  save: (key, report) => saveProbeRecord(options.probeRecordDir, knownKeyOf(key), report, options.currency, options.lock),
});

export type ProbeManagedOptions = {
  paths: MomongaPaths;
  lock: KernelLockMechanism;
  inspector: ProcessInspector;
  random: Random;
  fileSystem: FileSystemSync;
  platform: NodeJS.Platform;
  instance: ManagedInstancePaths;
  description: ManagedServerDescription;
  target: string;
  binary: string;
  readyTimeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
  model: string;
  samples?: number;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  signal: AbortSignal;
  exec?: ExecFn;
  hashes: BinaryHashCache;
  isUsableBinary: (binary: string) => Promise<boolean>;
  readStopGraceMs: () => number;
  timers: ManagedServerTimers;
  launch: ChildLaunch;
  stepTimeoutMs?: number;
  onWarning(message: string): void;
};

export type ProbeManagedResult = { report: ProbeReport; toolCalling: ToolCallingMode; recordFile: string };

export type ListManagedModelOptions = Omit<ProbeManagedOptions, 'model' | 'samples' | 'userDialects' | 'declaredDialect' | 'hashes' | 'platform' | 'stepTimeoutMs'>;

export const listManagedModel = async (options: ListManagedModelOptions): Promise<string> => {
  if (!(await options.isUsableBinary(options.binary))) throw targetNotReadyError(options.target, missingExecutableVerdict(options.target, options.binary));
  const childEnv = managedChildEnvOf(options.env);
  const { description } = options;
  const run = { ...options, env: childEnv, exec: options.exec ?? createExecFn(childEnv) };
  return onManagedServer(run, options.signal, async (socketPath) => {
    const client = createProbeClient(
      { kind: 'unix', socketPath },
      {
        signal: options.signal,
        bound: fixedStepBound(DEFAULT_STEP_TIMEOUT_MS),
        timers: options.timers,
        gate: PERSON_TRAFFIC,
        routes: { readyPath: description.ready.path, listPath: description.models.listPath, idPath: description.models.idPath },
      },
    );
    try {
      const listing = await client.get('models');
      if (listing.status !== 200) throw new Error(`the ${WORDS.server} ${description.id} answered GET ${description.models.listPath} with HTTP ${listing.status}`);
      const id = valueAtPath(parseExternalJson(listing.text), description.models.idPath);
      if (typeof id !== 'string') throw new Error(`the ${WORDS.server} ${description.id} lists no ${WORDS.model} id at GET ${description.models.listPath}`);
      return id;
    } finally {
      await client.close();
    }
  });
};

export const probeManagedFm = async (options: ProbeManagedOptions): Promise<ProbeManagedResult> => {
  if (!(await options.isUsableBinary(options.binary))) throw targetNotReadyError(options.target, missingExecutableVerdict(options.target, options.binary));
  const childEnv = managedChildEnvOf(options.env);
  const exec = options.exec ?? createExecFn(childEnv);
  const readKey = managedKeyReader({ description: options.description, binary: options.binary, model: options.model, exec, platform: options.platform, hashes: options.hashes });
  const subject = managedProbeSubject({
    target: options.target,
    precondition: managedPrecondition(options.description, options.target, options.binary, exec, options.isUsableBinary, options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS),
    probeRecordDir: options.paths.probe,
    lock: options.lock,
    readKey,
    keySignal: () => options.signal,
    measure: measureManagedServer({
      description: options.description,
      target: options.target,
      binary: options.binary,
      instance: options.instance,
      lock: options.lock,
      inspector: options.inspector,
      random: options.random,
      fileSystem: options.fileSystem,
      readyTimeoutMs: options.readyTimeoutMs,
      env: childEnv,
      exec,
      execWithStdin: createExecWithStdin(childEnv),
      readStopGraceMs: options.readStopGraceMs,
      timers: options.timers,
      launch: options.launch,
      gate: PERSON_TRAFFIC,
      ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
      onWarning: options.onWarning,
      model: options.model,
      ...(options.samples === undefined ? {} : { samples: options.samples }),
      ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
      ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
    }),
    currency: managedCurrencyOf(options.description, options),
  });
  const { key, report } = await recordProbe(subject, options.paths.probe, options.lock, options.timers, options.signal, options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
  return { report, toolCalling: decideToolCalling(report).mode, recordFile: managedRecordPath(options.paths.probe, knownKeyOf(key)) };
};
