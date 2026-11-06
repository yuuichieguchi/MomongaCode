import { declaredChildEnv, minimalChildEnv } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { DialectId, ProbeReport, ToolCallingMode } from '@momonga/protocol';
import { NO_USER_DIALECTS } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import { FM_SERVE_DEFAULTS } from '../defaults.ts';
import { createExecFn, createExecWithStdin } from '../managed/fm-processes.ts';
import { readOsBuild, sha256OfFile } from '../managed/fm-record-key.ts';
import { createFmServe } from '../managed/fm-serve.ts';
import type { ExecFn } from '../managed/fm-serve.ts';
import { parseCount } from '../managed/fm-target.ts';
import { FM_VOCABULARY } from '../adapters/chat-completions/vocabulary.ts';
import { decideToolCalling } from './decide.ts';
import type { DialectCurrency } from '../dialect/candidates.ts';
import { recordProbe } from './auto-probe.ts';
import type { MeasureProbe } from './auto-probe.ts';
import type { ProbeRecordKey } from './record.ts';
import { PROBE_METHOD_VERSION, runProbe } from './run-probe.ts';

export const FM_CHILD_ENV_NAMES: readonly string[] = [];

export type ProbeManagedFmOptions = {
  paths: Pick<MomongaPaths, 'probe'>;
  target: string;
  binary: string;
  socketPath: string;
  env: Readonly<Record<string, string | undefined>>;
  model?: string;
  samples?: number;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  signal?: AbortSignal;
  exec?: ExecFn;
  onWarning(message: string): void;
};

export type ProbeManagedFmResult = { report: ProbeReport; toolCalling: ToolCallingMode; record: ProbeRecordKey };

export type MeasureManagedFmOptions = Omit<ProbeManagedFmOptions, 'paths' | 'target' | 'signal'>;

const childEnvOf = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => ({ ...minimalChildEnv(env), ...declaredChildEnv(env, FM_CHILD_ENV_NAMES) });

export const readFmRecordKey = async (target: string, binary: string, exec: ExecFn): Promise<ProbeRecordKey> => ({
  target,
  binarySha256: await sha256OfFile(binary),
  osBuild: await readOsBuild(exec),
});

export const measureManagedFm =
  (options: MeasureManagedFmOptions): MeasureProbe =>
  async ({ signal }) => {
    const childEnv = childEnvOf(options.env);
    const exec = options.exec ?? createExecFn(childEnv);
    const execWithStdin = createExecWithStdin(childEnv);
    const fmServe = createFmServe({
      ...FM_SERVE_DEFAULTS,
      binary: options.binary,
      socketPath: options.socketPath,
      env: childEnv,
      onWarning: options.onWarning,
      exec,
    });
    try {
      const endpoint = await fmServe.start();
      return await runProbe({
        socketPath: endpoint.socketPath,
        managedHealthRoute: true,
        vocabulary: FM_VOCABULARY,
        ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
        ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
        ...(options.model === undefined ? {} : { model: options.model }),
        countTokens: async (text) => parseCount(await execWithStdin(options.binary, ['count-tokens', '-q'], text, signal)),
        ...(options.samples === undefined ? {} : { samples: options.samples }),
        signal,
      });
    } finally {
      await fmServe.stop();
    }
  };

export const fmDialectCurrencyOf = (options: Pick<ProbeManagedFmOptions, 'userDialects' | 'declaredDialect'>): DialectCurrency => ({
  userDialects: options.userDialects ?? NO_USER_DIALECTS,
  probeMethod: PROBE_METHOD_VERSION,
  ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
});

export const probeManagedFm = async (options: ProbeManagedFmOptions): Promise<ProbeManagedFmResult> => {
  const exec = options.exec ?? createExecFn(childEnvOf(options.env));
  const { key, report } = await recordProbe({
    dir: options.paths.probe,
    readKey: () => readFmRecordKey(options.target, options.binary, exec),
    measure: measureManagedFm(options),
    currency: fmDialectCurrencyOf(options),
    signal: options.signal ?? new AbortController().signal,
  });
  return { report, toolCalling: decideToolCalling(report).mode, record: key };
};
