import { minimalChildEnv } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { ProbeReport, ToolCallingMode } from '@momonga/protocol';
import { FM_SERVE_DEFAULTS } from '../defaults.ts';
import { createExecFn, createExecWithStdin } from '../managed/fm-processes.ts';
import { readOsBuild, sha256OfFile } from '../managed/fm-record-key.ts';
import { createFmServe } from '../managed/fm-serve.ts';
import { parseCount } from '../managed/fm-target.ts';
import { decideToolCalling } from './decide.ts';
import { saveProbeRecord } from './record.ts';
import type { ProbeRecordKey } from './record.ts';
import { runProbe } from './run-probe.ts';

export type ProbeManagedFmOptions = {
  paths: Pick<MomongaPaths, 'probe'>;
  target: string;
  binary: string;
  socketPath: string;
  env: Readonly<Record<string, string | undefined>>;
  samples?: number;
  signal?: AbortSignal;
  onWarning(message: string): void;
};

export type ProbeManagedFmResult = { report: ProbeReport; toolCalling: ToolCallingMode; record: ProbeRecordKey };

export const probeManagedFm = async (options: ProbeManagedFmOptions): Promise<ProbeManagedFmResult> => {
  const childEnv = minimalChildEnv(options.env);
  const exec = createExecFn(childEnv);
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
      countTokens: async (text) => parseCount(await execWithStdin(options.binary, ['count-tokens', '-q'], text, signal)),
      ...(options.samples === undefined ? {} : { samples: options.samples }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await saveProbeRecord(options.paths.probe, record, report);
    return { report, toolCalling: decideToolCalling(report).mode, record };
  } finally {
    await fmServe.stop();
  }
};
