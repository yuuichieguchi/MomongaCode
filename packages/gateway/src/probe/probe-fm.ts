import { declaredChildEnv, minimalChildEnv, probeKeyComponentLabel, readProbeKeyComponents } from '@momonga/foundation';
import type { BinaryHashCache, HeldHostReadings, ManagedInstancePaths, MomongaPaths } from '@momonga/foundation';
import { knownKeyOf, managedServerDigest, probeKeyOf } from '@momonga/config';
import type { ProbeKey } from '@momonga/config';
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
import { recordProbe } from './auto-probe.ts';
import type { MeasureProbe, ProbeLockKey, ProbePrecondition, ProbeSubject } from './auto-probe.ts';
import { managedRecordPath, saveProbeRecord } from './record.ts';
import type { ManagedRecordCurrency } from './record.ts';
import { DEFAULT_STEP_TIMEOUT_MS, PROBE_METHOD_VERSION, runProbe } from './run-probe.ts';

export const MANAGED_CHILD_ENV_NAMES: readonly string[] = [];

export const managedChildEnvOf = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => ({ ...minimalChildEnv(env), ...declaredChildEnv(env, MANAGED_CHILD_ENV_NAMES) });

export type ManagedKeyReaderOptions = {
  description: ManagedServerDescription;
  binary: string;
  model: string | undefined;
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

export const lockKeyOf = (key: Extract<ProbeKey, { kind: 'known' }>): ProbeLockKey => JSON.parse(key.canonical) as ProbeLockKey;

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
  readyTimeoutMs: number;
  env: Readonly<Record<string, string>>;
  exec: ExecFn;
  execWithStdin: ExecWithStdinFn;
  model?: string;
  samples?: number;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  servers?: Set<ManagedServer>;
  spawn?: SpawnFn;
  timers?: ManagedServerTimers;
  readStopGraceMs: () => number;
  onWarning(message: string): void;
};

export const measureManagedServer =
  (options: MeasureManagedServerOptions): MeasureProbe<ProbeLockKey, ProbeReport> =>
  async ({ signal }) => {
    const { description } = options;
    const server = createManagedServer({
      description,
      target: options.target,
      binary: options.binary,
      socketPath: options.instance.socketPath,
      lockPath: options.instance.lockPath,
      markerDirectory: options.instance.markerDirectory,
      readyTimeoutMs: options.readyTimeoutMs,
      env: options.env,
      exec: options.exec,
      readStopGraceMs: options.readStopGraceMs,
      onWarning: options.onWarning,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
    });
    options.servers?.add(server);
    const { tokenCount } = description;
    try {
      const endpoint = await server.start(signal);
      return await runProbe({
        socketPath: endpoint.socketPath,
        managed: { readyPath: description.ready.path, listPath: description.models.listPath, idPath: description.models.idPath },
        vocabulary: vocabularyOf(description),
        ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
        ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(tokenCount === 'estimated' ? {} : { countTokens: async (text: string) => parseCount(options.target, await options.execWithStdin(options.binary, tokenCount.argv, text, signal)) }),
        ...(options.samples === undefined ? {} : { samples: options.samples }),
        signal,
      });
    } finally {
      await server.stop({ stopGraceMs: options.readStopGraceMs() });
      options.servers?.delete(server);
    }
  };

export const managedPrecondition = (description: ManagedServerDescription, target: string, binary: string, exec: ExecFn, isUsableBinary: (binary: string) => Promise<boolean>, boundMs: number): ProbePrecondition => ({
  boundMs,
  check: async (signal) => ((await isUsableBinary(binary)) ? runPreconditions(description, binary, exec, signal) : missingExecutableVerdict(target, binary)),
});

export type ManagedProbeSubjectOptions = {
  target: string;
  precondition: ProbePrecondition;
  probeRecordDir: string;
  readKey: (signal: AbortSignal) => Promise<ProbeKey>;
  keySignal: () => AbortSignal;
  measure: MeasureProbe<ProbeLockKey, ProbeReport>;
  currency: ManagedRecordCurrency;
};

export class UnreadableProbeKeyError extends Error {
  constructor(target: string, component: string, reason: string) {
    super(`the target "${target}" is not ready: its probe key needs the ${probeKeyComponentLabel(component)}, which cannot be read: ${reason}`);
    this.name = 'UnreadableProbeKeyError';
  }
}

export const managedProbeSubject = (options: ManagedProbeSubjectOptions): ProbeSubject<ProbeLockKey, ProbeReport> => ({
  target: options.target,
  readKey: async () => {
    const key = await options.readKey(options.keySignal());
    if (key.kind === 'unknown') throw new UnreadableProbeKeyError(options.target, key.component, key.reason);
    return lockKeyOf(key);
  },
  precondition: options.precondition,
  measure: options.measure,
  save: (key, report) => saveProbeRecord(options.probeRecordDir, knownKeyOf(key), report, options.currency),
});

export type ProbeManagedOptions = {
  paths: MomongaPaths;
  instance: ManagedInstancePaths;
  description: ManagedServerDescription;
  target: string;
  binary: string;
  readyTimeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
  model?: string;
  samples?: number;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  signal: AbortSignal;
  exec?: ExecFn;
  hashes: BinaryHashCache;
  isUsableBinary: (binary: string) => Promise<boolean>;
  readStopGraceMs: () => number;
  onWarning(message: string): void;
};

export type ProbeManagedResult = { report: ProbeReport; toolCalling: ToolCallingMode; recordFile: string };

export const probeManagedFm = async (options: ProbeManagedOptions): Promise<ProbeManagedResult> => {
  const childEnv = managedChildEnvOf(options.env);
  const exec = options.exec ?? createExecFn(childEnv);
  const readKey = managedKeyReader({ description: options.description, binary: options.binary, model: options.model, exec, platform: process.platform, hashes: options.hashes });
  const subject = managedProbeSubject({
    target: options.target,
    precondition: managedPrecondition(options.description, options.target, options.binary, exec, options.isUsableBinary, DEFAULT_STEP_TIMEOUT_MS),
    probeRecordDir: options.paths.probe,
    readKey,
    keySignal: () => options.signal,
    measure: measureManagedServer({
      description: options.description,
      target: options.target,
      binary: options.binary,
      instance: options.instance,
      readyTimeoutMs: options.readyTimeoutMs,
      env: childEnv,
      exec,
      execWithStdin: createExecWithStdin(childEnv),
      readStopGraceMs: options.readStopGraceMs,
      onWarning: options.onWarning,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.samples === undefined ? {} : { samples: options.samples }),
      ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
      ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
    }),
    currency: managedCurrencyOf(options.description, options),
  });
  const { key, report } = await recordProbe(subject, options.paths.probe, options.signal);
  return { report, toolCalling: decideToolCalling(report).mode, recordFile: managedRecordPath(options.paths.probe, knownKeyOf(key)) };
};
