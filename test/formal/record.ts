import { COMPLETION_LINE, TEMPORAL_LINE, factsOf, problemsOf } from './verdict.ts';
import type { TlcFacts } from './verdict.ts';
import type { ManifestEntry, TlcRun } from './manifest-reader.ts';
import { specIdentityOf } from './reuse.ts';

const TIME_LINE = /^\s*([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/m;
const LOCK_WAIT_LINE = /run-lock: heavy run starts after waiting ([\d.]+) s/;
const DISTINCT_LINE = /(\d[\d,]*) states generated, (\d[\d,]*) distinct states found/g;
const INVARIANT_LINE = /Invariant \S+ is violated/;

export type Measurement = { readonly distinctStates: number; readonly measuredSeconds: number; readonly measuredCpuSeconds: number };

const round2 = (value: number): number => Math.round(value * 100) / 100;

const exitCodeOf = (stdout: string): 0 | 12 | 13 | undefined => {
  if (stdout.includes(COMPLETION_LINE)) return 0;
  if (INVARIANT_LINE.test(stdout)) return 12;
  if (stdout.includes(TEMPORAL_LINE)) return 13;
  return undefined;
};

const waitedSecondsOf = (log: string): number => {
  const waited = LOCK_WAIT_LINE.exec(log);
  return waited === null ? 0 : Number(waited[1]);
};

export const measurementOf = (log: string): Measurement => {
  const time = TIME_LINE.exec(log);
  const distinct = [...log.matchAll(DISTINCT_LINE)].at(-1);
  if (time === null) throw new Error('the log holds no /usr/bin/time -l line (real, user, sys)');
  if (distinct === undefined) throw new Error('the log holds no TLC state count');
  return {
    distinctStates: Number((distinct[2] as string).replaceAll(',', '')),
    measuredSeconds: round2(Math.max(0, Number(time[1]) - waitedSecondsOf(log))),
    measuredCpuSeconds: round2(Number(time[2]) + Number(time[3])),
  };
};

export const recordProblems = (entry: ManifestEntry, log: string, measurement: Measurement): string[] => {
  const exitCode = exitCodeOf(log);
  const run: TlcRun = { pid: 0, exitCode: exitCode ?? null, signal: null, killedAtCpuBudget: false, metadir: '', stdout: log, stderr: '' };
  const facts: TlcFacts = factsOf(run);
  return problemsOf({ ...entry, distinctStates: measurement.distinctStates }, facts);
};

export const recordedRow = async (repoRoot: string, row: ManifestEntry, log: string, startupCpuSeconds: number, load: string): Promise<Record<string, unknown>> => {
  const measurement = measurementOf(log);
  const budgetCpuSeconds = Math.ceil(2 * measurement.measuredCpuSeconds) + startupCpuSeconds;
  return {
    config: row.config,
    role: row.role,
    expect: row.expect,
    args: [...row.args],
    tier: row.tier,
    distinctStates: measurement.distinctStates,
    measuredSeconds: measurement.measuredSeconds,
    measuredReuse: 'off',
    measuredCpuSeconds: measurement.measuredCpuSeconds,
    budgetCpuSeconds,
    identity: await specIdentityOf(repoRoot, row),
    note: `measured cold (reuse off, scripts/tlc.sh under the heavy run lock, workers 5, nice 15, 1-minute load ${load} at start)`,
  };
};
