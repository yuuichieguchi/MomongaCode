import os from 'node:os';
import path from 'node:path';
import { createOwnedDirectory, nodeFileSystem } from '@momonga/foundation';
import { parseBenchmark, treeDigest } from './bench.ts';
import type { BenchTask } from './bench.ts';
import { diffLines } from './context-improve.ts';
import { filesUnder, gradeChecks } from './oracle-grade.ts';
import type { TrialGrade, WorkspaceProbe } from './oracle-grade.ts';

export type GradeInput = { task: BenchTask; workspace: string; base: string; probe: WorkspaceProbe };

export const gradeTrial = ({ task, workspace, base, probe }: GradeInput): Promise<TrialGrade> =>
  gradeChecks({ checks: task.oracle, graderFiles: task.graderFiles, workspace, base, probe });

export const BENCH_PROBLEMS = ['digest_mismatch', 'grader_file_in_repository', 'setup_failed', 'already_passing', 'unsolvable'] as const;
export type BenchProblem = (typeof BENCH_PROBLEMS)[number];

export type ReferenceChange = { files: number; linesAdded: number; linesRemoved: number };

export type TaskValidation = { id: string; difficulty: BenchTask['difficulty']; labelledBy: string; labelledAt: string; reference: ReferenceChange; problems: BenchProblem[] };

export type Validation = { name: string; tasks: TaskValidation[] };

const exists = (file: string): Promise<boolean> =>
  nodeFileSystem.access(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

const textOrAbsent = (file: string): Promise<string | undefined> =>
  nodeFileSystem.readTextFile(file).then(
    (text) => text,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );

const withoutLastLineBreak = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);

const referenceChangeOf = async (repository: string, reference: string): Promise<ReferenceChange> => {
  const change: ReferenceChange = { files: 0, linesAdded: 0, linesRemoved: 0 };
  for (const relative of await filesUnder(reference, '')) {
    const after = await nodeFileSystem.readTextFile(path.join(reference, relative));
    const before = await textOrAbsent(path.join(repository, relative));
    if (before === after) continue;
    change.files += 1;
    for (const line of diffLines(withoutLastLineBreak(before ?? ''), withoutLastLineBreak(after))) {
      if (line.startsWith('+')) change.linesAdded += 1;
      else if (line.startsWith('-')) change.linesRemoved += 1;
    }
  }
  return change;
};

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
  const referenceDirectory = path.join(root, task.reference.directory);
  const validation: TaskValidation = {
    id: task.id,
    difficulty: task.difficulty,
    labelledBy: task.labelledBy,
    labelledAt: task.labelledAt,
    reference: await referenceChangeOf(repositoryDirectory, referenceDirectory),
    problems,
  };
  const initial = await preparedWorkspace(scratch, `${task.id}-initial`, repositoryDirectory, task, probe);
  const solved = await preparedWorkspace(scratch, `${task.id}-reference`, repositoryDirectory, task, probe, referenceDirectory);
  if (initial === undefined || solved === undefined) {
    problems.push('setup_failed');
    return validation;
  }
  if ((await gradeTrial({ task, workspace: initial, base: repositoryDirectory, probe })).met) problems.push('already_passing');
  if (!(await gradeTrial({ task, workspace: solved, base: repositoryDirectory, probe })).met) problems.push('unsolvable');
  return validation;
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
    return { name: benchmark.name, tasks };
  } finally {
    await owned.dispose();
  }
};
