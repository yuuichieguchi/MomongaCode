import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from '@momonga/testkit/child-process';
import { WHOLE_RUN_ENV, fileFiltersOf, projectsOf } from './test-reuse.ts';
import { WHOLE_RUN_PROJECTS } from './whole-run-guard.ts';

export const GATE_RECORD_FILE = 'momonga-gate.json';
export const GATE_FORMAT = 'momonga-gate/1';

export type WholeRun = { readonly head: string; readonly startedAt: string };

export type GateRecord = {
  readonly format: typeof GATE_FORMAT;
  readonly head: string;
  readonly openedAt: string;
  readonly wholeRuns: Readonly<Record<string, WholeRun>>;
};

type GateRequest = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly projects: readonly string[];
  readonly recordPath: string;
  readonly recordText: string | undefined;
  readonly head: string;
  readonly now: Date;
};

export type GateDecision = { readonly kind: 'unchanged' } | { readonly kind: 'refused'; readonly message: string } | { readonly kind: 'record'; readonly record: GateRecord };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isWholeRun = (value: unknown): value is WholeRun => isRecord(value) && typeof value['head'] === 'string' && typeof value['startedAt'] === 'string';

export const parseGateRecord = (text: string): GateRecord | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['format'] !== GATE_FORMAT || typeof parsed['head'] !== 'string' || typeof parsed['openedAt'] !== 'string') return undefined;
  const wholeRuns = parsed['wholeRuns'];
  if (!isRecord(wholeRuns) || !Object.values(wholeRuns).every(isWholeRun)) return undefined;
  return { format: GATE_FORMAT, head: parsed['head'], openedAt: parsed['openedAt'], wholeRuns: wholeRuns as Record<string, WholeRun> };
};

export const gateDecisionOf = ({ argv, env, projects, recordPath, recordText, head, now }: GateRequest): GateDecision => {
  if (recordText === undefined || env[WHOLE_RUN_ENV] !== '1' || fileFiltersOf(argv).length > 0) return { kind: 'unchanged' };
  const named = projectsOf(argv);
  const started = (named.length > 0 ? named : projects).filter((project) => WHOLE_RUN_PROJECTS.includes(project));
  if (started.length === 0) return { kind: 'unchanged' };
  const record = parseGateRecord(recordText);
  if (record === undefined) return { kind: 'refused', message: `run-lock: the gate record ${recordPath} is not a ${GATE_FORMAT} record, and this whole run is refused before any test starts. Show it with node scripts/gate.ts status, or close the gate with node scripts/gate.ts close.` };
  const repeated = started.find((project) => record.wholeRuns[project] !== undefined);
  if (repeated !== undefined) {
    const earlier = record.wholeRuns[repeated] as WholeRun;
    return {
      kind: 'refused',
      message: `run-lock: the gate opened on ${record.head} allows one whole run of each project, and the whole ${repeated} project already ran on ${earlier.head} at ${earlier.startedAt}; this run is refused before any test starts. Name the test files to run (vitest run --project ${repeated} <file>).`,
    };
  }
  const added = Object.fromEntries(started.map((project) => [project, { head, startedAt: now.toISOString() }]));
  return { kind: 'record', record: { ...record, wholeRuns: { ...record.wholeRuns, ...added } } };
};

const git = (cwd: string, args: readonly string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const gitCommonDirOf = (cwd: string): string => path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));

const NOT_A_REPOSITORY_STATUS = 128;

export const gitCommonDirWhenPresentOf = (cwd: string): string | undefined => {
  try {
    return gitCommonDirOf(cwd);
  } catch (error) {
    if (isRecord(error) && (error['code'] === 'ENOENT' || error['status'] === NOT_A_REPOSITORY_STATUS)) return undefined;
    throw error;
  }
};

export const headOf = (cwd: string): string => git(cwd, ['rev-parse', 'HEAD']);

export const gateRecordPathOf = (commonDir: string): string => path.join(commonDir, GATE_RECORD_FILE);

export const readGateRecordText = (recordPath: string): string | undefined => {
  try {
    return fs.readFileSync(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

export const writeGateRecord = (recordPath: string, record: GateRecord): void => {
  const staged = path.join(path.dirname(recordPath), `.${GATE_RECORD_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(staged, recordPath);
};
