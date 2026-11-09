import os from 'node:os';
import path from 'node:path';
import { createOwnedDirectory, nodeFileSystem } from '@momonga/foundation';
import { parseBenchmark, treeDigest } from './bench.ts';
import type { BenchTask, OracleCheck } from './bench.ts';

export type WorkspaceProbe = {
  run(command: string, timeoutMs: number, cwd: string): Promise<{ exitCode: number | null; timedOut: boolean }>;
  digest(cwd: string, paths: readonly string[]): Promise<string>;
  changedPaths(cwd: string, baseDir: string): Promise<string[]>;
};

export type CheckResult = { id: string; passed: boolean; reason?: 'timeout' | 'exit' | 'changed' | 'out_of_scope' };

export type TrialGrade = { met: boolean; checks: CheckResult[] };

export type GradeInput = { task: BenchTask; workspace: string; base: string; probe: WorkspaceProbe };

const within = (changed: string, allowed: string): boolean => (allowed.endsWith('/') ? changed.startsWith(allowed) : changed === allowed || changed.startsWith(`${allowed}/`));

const filesUnder = async (root: string, relative: string): Promise<string[]> => {
  const stat = await nodeFileSystem.stat(path.join(root, relative)).then(
    (found) => found,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (stat === undefined || !stat.isDirectory()) return stat === undefined ? [] : [relative];
  const children = await nodeFileSystem.readdir(path.join(root, relative));
  const nested = await Promise.all(children.map((child) => filesUnder(root, path.posix.join(relative, child))));
  return nested.flat();
};

const filesOfPaths = async (paths: readonly string[], roots: readonly string[]): Promise<string[]> => {
  const found = await Promise.all(paths.flatMap((entry) => roots.map((root) => filesUnder(root, entry.replace(/\/$/, '')))));
  return [...new Set(found.flat())].sort();
};

const pathCheck = async (check: Exclude<OracleCheck, { kind: 'command' }>, { workspace, base, probe }: GradeInput): Promise<CheckResult> => {
  if (check.kind === 'unchangedPaths') {
    const files = await filesOfPaths(check.paths, [workspace, base]);
    const [after, before] = await Promise.all([probe.digest(workspace, files), probe.digest(base, files)]);
    return after === before ? { id: check.id, passed: true } : { id: check.id, passed: false, reason: 'changed' };
  }
  const changed = await probe.changedPaths(workspace, base);
  const stray = changed.some((entry) => !check.paths.some((allowed) => within(entry, allowed)));
  return stray ? { id: check.id, passed: false, reason: 'out_of_scope' } : { id: check.id, passed: true };
};

const commandCheck = async (check: Extract<OracleCheck, { kind: 'command' }>, { workspace, probe }: GradeInput): Promise<CheckResult> => {
  const outcome = await probe.run(check.run, check.timeoutMs, workspace);
  if (outcome.timedOut) return { id: check.id, passed: false, reason: 'timeout' };
  return outcome.exitCode === check.expectExit ? { id: check.id, passed: true } : { id: check.id, passed: false, reason: 'exit' };
};

const writeGraderFiles = async (task: BenchTask, workspace: string): Promise<void> => {
  for (const [relative, content] of Object.entries(task.graderFiles)) {
    await nodeFileSystem.mkdir(path.dirname(path.join(workspace, relative)));
    await nodeFileSystem.writeFile(path.join(workspace, relative), content);
  }
};

export const gradeTrial = async (input: GradeInput): Promise<TrialGrade> => {
  const { task } = input;
  const pathResults = new Map<string, CheckResult>();
  for (const check of task.oracle) {
    if (check.kind !== 'command') pathResults.set(check.id, await pathCheck(check, input));
  }
  await writeGraderFiles(task, input.workspace);
  const checks: CheckResult[] = [];
  for (const check of task.oracle) {
    const result = check.kind === 'command' ? await commandCheck(check, input) : pathResults.get(check.id);
    if (result === undefined) throw new Error(`oracle check ${check.id} of task ${task.id} produced no result`);
    checks.push(result);
  }
  return { met: checks.every((check) => check.passed), checks };
};

export const BENCH_PROBLEMS = ['digest_mismatch', 'grader_file_in_repository', 'setup_failed', 'already_passing', 'unsolvable'] as const;
export type BenchProblem = (typeof BENCH_PROBLEMS)[number];

export type TaskValidation = { id: string; problems: BenchProblem[] };

export type Validation = { tasks: TaskValidation[] };

const exists = (file: string): Promise<boolean> =>
  nodeFileSystem.access(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

const preparedWorkspace = async (scratch: string, name: string, repository: string, task: BenchTask, probe: WorkspaceProbe, reference?: string): Promise<string | undefined> => {
  const workspace = path.join(scratch, name);
  await nodeFileSystem.cp(repository, workspace);
  for (const step of task.setup) {
    const outcome = await probe.run(step.run, step.timeoutMs, workspace);
    if (outcome.timedOut || outcome.exitCode !== 0) return undefined;
  }
  if (reference !== undefined) await nodeFileSystem.cp(reference, workspace);
  return workspace;
};

const validateTask = async (task: BenchTask, root: string, repository: { directory: string; digest: string }, probe: WorkspaceProbe, scratch: string): Promise<TaskValidation> => {
  const problems: BenchProblem[] = [];
  const repositoryDirectory = path.join(root, repository.directory);
  if ((await treeDigest(repositoryDirectory)) !== repository.digest) problems.push('digest_mismatch');
  for (const relative of Object.keys(task.graderFiles)) {
    if (await exists(path.join(repositoryDirectory, relative))) {
      problems.push('grader_file_in_repository');
      break;
    }
  }
  const initial = await preparedWorkspace(scratch, `${task.id}-initial`, repositoryDirectory, task, probe);
  const solved = await preparedWorkspace(scratch, `${task.id}-reference`, repositoryDirectory, task, probe, path.join(root, task.reference.directory));
  if (initial === undefined || solved === undefined) {
    problems.push('setup_failed');
    return { id: task.id, problems };
  }
  if ((await gradeTrial({ task, workspace: initial, base: repositoryDirectory, probe })).met) problems.push('already_passing');
  if (!(await gradeTrial({ task, workspace: solved, base: repositoryDirectory, probe })).met) problems.push('unsolvable');
  return { id: task.id, problems };
};

export const validateBenchmark = async (benchmarkFile: string, probe: WorkspaceProbe): Promise<Validation> => {
  const benchmark = parseBenchmark(await nodeFileSystem.readTextFile(benchmarkFile), benchmarkFile);
  const root = path.dirname(path.resolve(benchmarkFile));
  const owned = await createOwnedDirectory({ parent: os.tmpdir(), prefix: 'momonga-bench-validate-' });
  const scratch = owned.path;
  try {
    const tasks: TaskValidation[] = [];
    for (const task of benchmark.tasks) {
      const repository = benchmark.repositories[task.repository];
      if (repository === undefined) throw new Error(`task ${task.id} names the repository ${task.repository}, which the file does not declare`);
      tasks.push(await validateTask(task, root, repository, probe, scratch));
    }
    return { tasks };
  } finally {
    await owned.dispose();
  }
};
