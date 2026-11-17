import fs from 'node:fs';
import path from 'node:path';
import { COMPLETION_LINE, TEMPORAL_LINE, factsOf, problemsOf } from './verdict.ts';
import type { TlcFacts } from './verdict.ts';
import type { ManifestEntry, TlcRun } from './manifest-reader.ts';
import { specIdentityOf } from './reuse.ts';

export const RECORD_ENV = 'MOMONGA_TLC_RECORD';

const TIME_LINE = /^\s*([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/m;
const LOCK_WAIT_LINE = /run-lock: heavy run starts after waiting ([\d.]+) s/;
const DISTINCT_LINE = /(\d[\d,]*) states generated, (\d[\d,]*) distinct states found/g;
const INVARIANT_LINE = /Invariant \S+ is violated/;
const ACTION_PROPERTY_LINE = /Action property \S+ is violated/;

export type Measurement = { readonly distinctStates: number; readonly measuredSeconds: number; readonly measuredCpuSeconds: number };

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const recordModeOf = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const value = env[RECORD_ENV];
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`${RECORD_ENV} must be 1 or 0, got "${value}"`);
};

export const recordsTier = (tier: string, env: Readonly<Record<string, string | undefined>>): boolean => recordModeOf(env) && tier === 'deep';

const exitCodeOf = (stdout: string): 0 | 12 | 13 | undefined => {
  if (stdout.includes(COMPLETION_LINE)) return 0;
  if (INVARIANT_LINE.test(stdout)) return 12;
  if (stdout.includes(TEMPORAL_LINE) || ACTION_PROPERTY_LINE.test(stdout)) return 13;
  return undefined;
};

const waitedSecondsOf = (log: string): number => {
  const waited = LOCK_WAIT_LINE.exec(log);
  return waited === null ? 0 : Number(waited[1]);
};

const distinctStatesOf = (stdout: string): number => {
  const distinct = [...stdout.matchAll(DISTINCT_LINE)].at(-1);
  if (distinct === undefined) throw new Error('the log holds no TLC state count');
  return Number((distinct[2] as string).replaceAll(',', ''));
};

export const measurementOf = (log: string): Measurement => {
  const time = TIME_LINE.exec(log);
  if (time === null) throw new Error('the log holds no /usr/bin/time -l line (real, user, sys)');
  return {
    distinctStates: distinctStatesOf(log),
    measuredSeconds: round2(Math.max(0, Number(time[1]) - waitedSecondsOf(log))),
    measuredCpuSeconds: round2(Number(time[2]) + Number(time[3])),
  };
};

export const measurementOfRun = (run: TlcRun, wallSeconds: number): Measurement => ({
  distinctStates: distinctStatesOf(run.stdout),
  measuredSeconds: round2(Math.max(0, wallSeconds - waitedSecondsOf(`${run.stderr}\n${run.stdout}`))),
  measuredCpuSeconds: round2(run.usedCpuSeconds),
});

export const recordProblems = (entry: ManifestEntry, log: string, measurement: Measurement): string[] => {
  const exitCode = exitCodeOf(log);
  const run: TlcRun = { pid: 0, exitCode: exitCode ?? null, signal: null, killedAtCpuBudget: false, metadir: '', stdout: log, stderr: '', usedCpuSeconds: 0 };
  const facts: TlcFacts = factsOf(run);
  return problemsOf({ ...entry, distinctStates: measurement.distinctStates }, facts);
};

export const recordedRowOf = async (repoRoot: string, row: ManifestEntry, measurement: Measurement, startupCpuSeconds: number, load: number): Promise<Record<string, unknown>> => {
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
    note: `measured cold (not replayed, scripts/tlc.sh under the heavy run lock, workers 5, nice 15, 1-minute load ${load.toFixed(2)} at start)`,
  };
};

export const recordedRow = async (repoRoot: string, row: ManifestEntry, log: string, startupCpuSeconds: number, load: string): Promise<Record<string, unknown>> =>
  recordedRowOf(repoRoot, row, measurementOf(log), startupCpuSeconds, Number(load));

export const writeManifestRows = (manifestPath: string, rows: readonly Record<string, unknown>[]): void => {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { entries: Record<string, unknown>[] };
  for (const row of rows) {
    const index = raw.entries.findIndex((entry) => entry['config'] === row['config']);
    if (index === -1) throw new Error(`${String(row['config'])} has no row in ${manifestPath}`);
    raw.entries[index] = { ...raw.entries[index], ...row };
  }
  const temporary = path.join(path.dirname(manifestPath), `.${path.basename(manifestPath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(temporary, manifestPath);
};
