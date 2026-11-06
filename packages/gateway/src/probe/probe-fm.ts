import { minimalChildEnv } from '@momonga/foundation';
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
import { saveProbeRecord } from './record.ts';
import type { ProbeRecordKey } from './record.ts';
import { PROBE_METHOD_VERSION, runProbe } from './run-probe.ts';

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

export const probeManagedFm = async (options: ProbeManagedFmOptions): Promise<ProbeManagedFmResult> => {
  const childEnv = minimalChildEnv(options.env);
  const exec = options.exec ?? createExecFn(childEnv);
  const execWithStdin = createExecWithStdin(childEnv);
  const record: ProbeRecordKey = {
    target: options.target,
    binarySha256: await sha256OfFile(options.binary),
    osBuild: await readOsBuild(exec),
  };
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
    const signal = options.signal ?? new AbortController().signal;
    const report = await runProbe({
      socketPath: endpoint.socketPath,
      managedHealthRoute: true,
      vocabulary: FM_VOCABULARY,
      ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
      ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
      ...(options.model === undefined ? {} : { model: options.model }),
      countTokens: async (text) => parseCount(await execWithStdin(options.binary, ['count-tokens', '-q'], text, signal)),
      ...(options.samples === undefined ? {} : { samples: options.samples }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await saveProbeRecord(options.paths.probe, record, report, {
      userDialects: options.userDialects ?? NO_USER_DIALECTS,
      probeMethod: PROBE_METHOD_VERSION,
      ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
    });
    return { report, toolCalling: decideToolCalling(report).mode, record };
  } finally {
    await fmServe.stop();
  }
};
