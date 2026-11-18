import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostE2eFileWorkers } from '../e2e/support/parallelism.ts';
import { vitestProjectBudgetOf } from './support/run-budgets.ts';
import { RUN_LOCK_ENV } from './support/run-lock.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SELF = path.join(REPO_ROOT, 'scripts', 'test-under-load.ts');
const RUN_LOCK = path.join(REPO_ROOT, 'scripts', 'run-lock.ts');
const VITEST = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const WHOLE_RUN_ENV = 'MOMONGA_WHOLE_RUN';
const TEST_REUSE_ENV = 'MOMONGA_TEST_REUSE';
const DEFAULT_REPEAT = 3;
const CONFIG_REPORTERS = ['default', './test/support/skip-ledger.ts', './test/support/reuse-reporter.ts'];
const HELPER_NICE = 15;
const HELPER_SOURCE = 'for (;;) Math.sqrt(Math.random());';
const LOAD_PROJECTS = ['e2e', 'unit'] as const;
const PROJECT_GLOBS: Readonly<Record<LoadProject, RegExp>> = {
  e2e: /^e2e\/.+\.test\.ts$/,
  unit: /^(?:packages\/[^/]+\/test\/(?!calibration\/).+\.test\.tsx?|test\/.+\.test\.ts)$/,
};
const USAGE = 'usage: npm run test:load -- [--repeat N] [--project e2e|unit] <test files...>   (no files only with MOMONGA_WHOLE_RUN=1: every file of the project)';

export type LoadProject = (typeof LOAD_PROJECTS)[number];

export type LoadRequest = { readonly repeat: number; readonly project: LoadProject; readonly files: readonly string[] };

export type LoadFailure = { readonly file: string; readonly test: string; readonly error: string; readonly repetition: number };

export type BudgetShare = { readonly projectBudgetCpuSeconds: number; readonly repeat: number; readonly namedFiles: number; readonly projectFiles: number; readonly workers: number };

const isLoadProject = (value: string): value is LoadProject => (LOAD_PROJECTS as readonly string[]).includes(value);

export const loadRequestOf = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>): LoadRequest => {
  let repeat = DEFAULT_REPEAT;
  let project: LoadProject = 'e2e';
  const files: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--repeat' || arg === '--project') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      index += 1;
      if (arg === '--repeat') {
        if (!/^[1-9]\d*$/.test(value)) throw new Error(`--repeat must be a whole number above 0, not ${value}\n${USAGE}`);
        repeat = Number(value);
      } else {
        if (!isLoadProject(value)) throw new Error(`--project must be one of ${LOAD_PROJECTS.join(', ')}, not ${value}\n${USAGE}`);
        project = value;
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}\n${USAGE}`);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0 && env[WHOLE_RUN_ENV] !== '1') throw new Error(`no test file named: name the files, or set ${WHOLE_RUN_ENV}=1 to run every file of the project\n${USAGE}`);
  for (const file of files) {
    if (!PROJECT_GLOBS[project].test(file.split(path.sep).join('/'))) throw new Error(`${file} is not a test file of the ${project} project (name test files relative to the repository root, never a directory)`);
  }
  return { repeat, project, files };
};

export const budgetShareCpuSeconds = ({ projectBudgetCpuSeconds, repeat, namedFiles, projectFiles, workers }: BudgetShare): number => {
  if (projectFiles <= 0) throw new Error('the project has no test files');
  const rounds = Math.ceil(namedFiles / workers);
  const share = namedFiles === 0 ? 1 : Math.min(1, (rounds * workers) / projectFiles);
  return Math.ceil(projectBudgetCpuSeconds * share * repeat);
};

export const projectWorkersOf = (project: LoadProject, processors: number): number => (project === 'e2e' ? hostE2eFileWorkers() : Math.max(1, processors - 1));

export const helperCountOf = ({ processors, workers, files }: { readonly processors: number; readonly workers: number; readonly files: number }): number => {
  const busy = files === 0 ? workers : Math.min(workers, files);
  return Math.max(1, processors - busy);
};

type Row = Readonly<Record<string, unknown>>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

const rowsAt = (row: Row, key: string): Row[] => {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRow);
};

const textAt = (row: Row, key: string): string | undefined => {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
};

const firstLineOf = (messages: unknown): string => {
  const joined = Array.isArray(messages) ? messages.filter((message): message is string => typeof message === 'string').join('\n') : typeof messages === 'string' ? messages : '';
  const line = joined
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? '(no error message)';
};

export const failuresOfReport = (report: unknown, repetition: number, repoRoot: string): LoadFailure[] => {
  if (!isRow(report)) throw new Error('the vitest JSON report is not an object');
  const failures: LoadFailure[] = [];
  for (const fileRow of rowsAt(report, 'testResults')) {
    const name = textAt(fileRow, 'name') ?? '(unknown file)';
    const file = path.isAbsolute(name) ? path.relative(repoRoot, name) : name;
    const failedTests = rowsAt(fileRow, 'assertionResults').filter((test) => test['status'] === 'failed');
    for (const test of failedTests) failures.push({ file, test: textAt(test, 'fullName') ?? textAt(test, 'title') ?? '(unnamed test)', error: firstLineOf(test['failureMessages']), repetition });
    if (failedTests.length === 0 && fileRow['status'] === 'failed') failures.push({ file, test: '(file)', error: firstLineOf(fileRow['message']), repetition });
  }
  return failures;
};

export const runFailureOf = (repetition: number, exitCode: number | null, signal: NodeJS.Signals | null, reported: number): LoadFailure | undefined => {
  if (exitCode === 0 || reported > 0) return undefined;
  return { file: '(run)', test: '(vitest)', error: signal === null ? `vitest ended with exit code ${exitCode} and reported no failing test` : `vitest ended by ${signal} and reported no failing test`, repetition };
};

export const failureListOf = (failures: readonly LoadFailure[], repeat: number): string => {
  const grouped = new Map<string, { file: string; test: string; error: string; repetitions: number[] }>();
  for (const failure of failures) {
    const key = `${failure.file}\u0000${failure.test}`;
    const entry = grouped.get(key);
    if (entry === undefined) grouped.set(key, { file: failure.file, test: failure.test, error: failure.error, repetitions: [failure.repetition] });
    else if (!entry.repetitions.includes(failure.repetition)) entry.repetitions.push(failure.repetition);
  }
  const lines = [...grouped.values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test))
    .map(({ file, test, error, repetitions }) => `LOAD_FAILURE ${file} | ${test} | failed in ${repetitions.length} of ${repeat} (repetition ${repetitions.sort((a, b) => a - b).join(', ')}) | ${error}`);
  return [...lines, `LOAD_FAILURES=${grouped.size}`].join('\n');
};

const projectFilesOf = (project: LoadProject): number => {
  const pattern = PROJECT_GLOBS[project];
  const roots = project === 'e2e' ? ['e2e'] : ['packages', 'test'];
  return roots
    .flatMap((root) => fs.readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: 'utf8' }).map((entry) => `${root}/${entry.split(path.sep).join('/')}`))
    .filter((file) => !file.includes('/node_modules/') && pattern.test(file)).length;
};

const startHelpers = (count: number): ChildProcess[] =>
  Array.from({ length: count }, () => spawn('nice', ['-n', String(HELPER_NICE), process.execPath, '-e', HELPER_SOURCE], { stdio: 'ignore' }));

const endOf = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

const runRepetition = async (request: LoadRequest, repetition: number, reportDir: string): Promise<LoadFailure[]> => {
  const reportFile = path.join(reportDir, `repetition-${repetition}.json`);
  process.stdout.write(`LOAD_REPETITION ${repetition} of ${request.repeat}: vitest run --project ${request.project} ${request.files.length === 0 ? '(every file)' : request.files.join(' ')}\n`);
  const child = spawn(process.execPath, [VITEST, 'run', '--project', request.project, ...CONFIG_REPORTERS.map((reporter) => `--reporter=${reporter}`), '--reporter=json', `--outputFile.json=${reportFile}`, ...request.files], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, [TEST_REUSE_ENV]: '0', ...(request.files.length === 0 ? { [WHOLE_RUN_ENV]: '1' } : {}) },
  });
  const { code, signal } = await endOf(child);
  const reported = fs.existsSync(reportFile) ? failuresOfReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')), repetition, REPO_ROOT) : [];
  const runFailure = runFailureOf(repetition, code, signal, reported.length);
  return runFailure === undefined ? reported : [...reported, runFailure];
};

const runUnderLoad = async (request: LoadRequest): Promise<number> => {
  const processors = os.availableParallelism();
  const helpers = startHelpers(helperCountOf({ processors, workers: projectWorkersOf(request.project, processors), files: request.files.length }));
  const helperEnds = helpers.map(endOf);
  process.stdout.write(`LOAD_HELPERS ${helpers.length} (nice ${HELPER_NICE}) on ${processors} processors\n`);
  const reportDir = createTempRoot({ prefix: 'momonga-test-load-' });
  const failures: LoadFailure[] = [];
  try {
    for (let repetition = 1; repetition <= request.repeat; repetition += 1) failures.push(...(await runRepetition(request, repetition, reportDir)));
  } finally {
    for (const helper of helpers) helper.kill('SIGKILL');
    await Promise.all(helperEnds);
    await removeTempRoot(reportDir);
  }
  process.stdout.write(`${failureListOf(failures, request.repeat)}\n`);
  return failures.length === 0 ? 0 : 1;
};

const underLock = async (argv: readonly string[], request: LoadRequest): Promise<number> => {
  const projectBudgetCpuSeconds = vitestProjectBudgetOf(request.project);
  if (projectBudgetCpuSeconds === undefined) throw new Error(`no CPU budget for project ${request.project} in vitestProjects of specs/tla/manifest.json`);
  const budget = budgetShareCpuSeconds({ projectBudgetCpuSeconds, repeat: request.repeat, namedFiles: request.files.length, projectFiles: projectFilesOf(request.project), workers: projectWorkersOf(request.project, os.availableParallelism()) });
  const child = spawn(process.execPath, [RUN_LOCK, 'heavy', '--budget-cpu-seconds', String(budget), '--', process.execPath, SELF, ...argv], { stdio: 'inherit', env: process.env });
  const { code, signal } = await endOf(child);
  if (signal !== null) return 128 + os.constants.signals[signal];
  if (code === null) throw new Error('the run lock ended with neither an exit code nor a signal');
  return code;
};

export const main = async (argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> => {
  let request: LoadRequest;
  try {
    request = loadRequestOf(argv, env);
  } catch (error) {
    process.stderr.write(`test-under-load: ${error instanceof Error ? error.message : String(error)}\n`);
    return 64;
  }
  return env[RUN_LOCK_ENV] === undefined ? underLock(argv, request) : runUnderLoad(request);
};

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
