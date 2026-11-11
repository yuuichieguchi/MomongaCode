import path from 'node:path';
import { createOwnedDirectory } from '@momonga/foundation';
import { parseBenchmark, treeDigest } from './bench.ts';
import type { BenchTask } from './bench.ts';
import { diffLines } from './context-improve.ts';
import type { WorkspaceFiles } from './files.ts';
import { filesUnder, gradeChecks } from './oracle-grade.ts';
import type { TrialGrade, WorkspaceProbe } from './oracle-grade.ts';

export type GradeInput = { task: BenchTask; workspace: string; base: string; probe: WorkspaceProbe; files: WorkspaceFiles };

export const gradeTrial = ({ task, workspace, base, probe, files }: GradeInput): Promise<TrialGrade> =>
  gradeChecks({ checks: task.oracle, graderFiles: task.graderFiles, workspace, base, probe, files });

export type ValidationPorts = { probe: WorkspaceProbe; files: WorkspaceFiles; tmpdir: string };

export const BENCH_PROBLEMS = ['digest_mismatch', 'grader_file_in_repository', 'setup_failed', 'already_passing', 'unsolvable'] as const;
export type BenchProblem = (typeof BENCH_PROBLEMS)[number];

export type ReferenceChange = { files: number; linesAdded: number; linesRemoved: number };

export type TaskValidation = { id: string; difficulty: BenchTask['difficulty']; labelledBy: string; labelledAt: string; reference: ReferenceChange; problems: BenchProblem[] };

export type Validation = { name: string; tasks: TaskValidation[] };

const exists = (files: WorkspaceFiles, file: string): Promise<boolean> =>
  files.access(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

const textOrAbsent = (files: WorkspaceFiles, file: string): Promise<string | undefined> =>
  files.readTextFile(file).then(
    (text) => text,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );

const withoutLastLineBreak = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);

const referenceChangeOf = async (files: WorkspaceFiles, repository: string, reference: string): Promise<ReferenceChange> => {
  const change: ReferenceChange = { files: 0, linesAdded: 0, linesRemoved: 0 };
  for (const relative of await filesUnder(files, reference, '')) {
    const after = await files.readTextFile(path.join(reference, relative));
    const before = await textOrAbsent(files, path.join(repository, relative));
    if (before === after) continue;
    change.files += 1;
    for (const line of diffLines(withoutLastLineBreak(before ?? ''), withoutLastLineBreak(after))) {
      if (line.startsWith('+')) change.linesAdded += 1;
      else if (line.startsWith('-')) change.linesRemoved += 1;
    }
  }
  return change;
};

const preparedWorkspace = async ({ probe, files }: ValidationPorts, scratch: string, name: string, repository: string, task: BenchTask, reference?: string): Promise<string | undefined> => {
  const workspace = path.join(scratch, name);
  await files.cp(repository, workspace);
  for (const step of task.setup) {
    const outcome = await probe.run(step.run, step.timeoutMs, workspace);
    if (outcome.timedOut || outcome.exitCode !== 0) return undefined;
  }
  if (reference !== undefined) await files.cp(reference, workspace);
  return workspace;
};

const validateTask = async (task: BenchTask, root: string, repository: { directory: string; digest: string }, ports: ValidationPorts, scratch: string): Promise<TaskValidation> => {
  const { probe, files } = ports;
  const problems: BenchProblem[] = [];
  const repositoryDirectory = path.join(root, repository.directory);
  if ((await treeDigest(files, repositoryDirectory)) !== repository.digest) problems.push('digest_mismatch');
  for (const relative of Object.keys(task.graderFiles)) {
    if (await exists(files, path.join(repositoryDirectory, relative))) {
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
    reference: await referenceChangeOf(files, repositoryDirectory, referenceDirectory),
    problems,
  };
  const initial = await preparedWorkspace(ports, scratch, `${task.id}-initial`, repositoryDirectory, task);
  const solved = await preparedWorkspace(ports, scratch, `${task.id}-reference`, repositoryDirectory, task, referenceDirectory);
  if (initial === undefined || solved === undefined) {
    problems.push('setup_failed');
    return validation;
  }
  if ((await gradeTrial({ task, workspace: initial, base: repositoryDirectory, probe, files })).met) problems.push('already_passing');
  if (!(await gradeTrial({ task, workspace: solved, base: repositoryDirectory, probe, files })).met) problems.push('unsolvable');
  return validation;
};

export const validateBenchmark = async (benchmarkFile: string, ports: ValidationPorts): Promise<Validation> => {
  const benchmark = parseBenchmark(await ports.files.readTextFile(benchmarkFile), benchmarkFile);
  const root = path.dirname(path.resolve(benchmarkFile));
  const owned = await createOwnedDirectory({ parent: ports.tmpdir, prefix: 'momonga-bench-validate-' });
  const scratch = owned.path;
  try {
    const tasks: TaskValidation[] = [];
    for (const task of benchmark.tasks) {
      const repository = benchmark.repositories[task.repository];
      if (repository === undefined) throw new Error(`task ${task.id} names the repository ${task.repository}, which the file does not declare`);
      tasks.push(await validateTask(task, root, repository, ports, scratch));
    }
    return { name: benchmark.name, tasks };
  } finally {
    await owned.dispose();
  }
};
