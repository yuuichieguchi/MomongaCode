import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { AnsweredByView, RunFactsView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport } from '@momonga/reliability';
import type { GroupKey, ReliabilityReport, TaskRow } from '@momonga/reliability';
import type { Benchmark, BenchTask } from './bench.ts';
import { uniqueAnswerers } from './context-report.ts';
import { EvalError } from './runner.ts';

export type BenchmarkTrial = { taskId: string; trial: number; facts: RunFactsView };

export type BuildBenchmarkReportInput = {
  benchmark: Benchmark;
  trials: readonly BenchmarkTrial[];
  answeredBy: readonly AnsweredByView[];
  unrecordedAnswers: number;
  codeDigest: string;
  groupBy: GroupKey;
};

export const suiteDigestOf = (parsed: unknown): string => sha256Hex(canonicalJson(parsed));

const assertRecordedAsDeclared = ({ taskId, trial, facts }: BenchmarkTrial, task: BenchTask): void => {
  const where = `task ${taskId} trial ${trial} (run ${facts.runId})`;
  const differences: string[] = [];
  if (facts.mode !== task.permissionMode) differences.push(`it ran in mode ${facts.mode} and the task declares ${task.permissionMode}`);
  if (facts.limits.maxSteps !== task.budget.maxSteps) differences.push(`it ran with maxSteps ${facts.limits.maxSteps} and the task declares ${task.budget.maxSteps}`);
  if (facts.limits.maxTotalTokens !== task.budget.maxTotalTokens) {
    differences.push(`it ran with maxTotalTokens ${facts.limits.maxTotalTokens} and the task declares ${task.budget.maxTotalTokens}`);
  }
  const timeoutMs = facts.deadlineAt === undefined ? undefined : facts.deadlineAt - facts.createdAt;
  if (timeoutMs !== task.budget.timeoutMs) differences.push(`it ran with timeoutMs ${timeoutMs} and the task declares ${task.budget.timeoutMs}`);
  if (differences.length > 0) throw new EvalError(`${where}: ${differences.join('; ')}, so the harness did not run the task as declared and no report can be built`);
};

const rowOf = (task: BenchTask, trials: readonly BenchmarkTrial[]): TaskRow => ({
  task: task.id,
  trials: trials.length,
  met: trials.filter((entry) => entry.facts.met).length,
  difficulty: task.difficulty,
  taskType: task.taskType,
});

export const buildBenchmarkReport = (input: BuildBenchmarkReportInput): ReliabilityReport => {
  const { benchmark } = input;
  const tasksById = new Map(benchmark.tasks.map((task) => [task.id, task]));
  const trialsByTask = new Map<string, BenchmarkTrial[]>();
  for (const trial of input.trials) {
    const task = tasksById.get(trial.taskId);
    if (task === undefined) throw new EvalError(`trial ${trial.trial} (run ${trial.facts.runId}) names the task ${trial.taskId}, which the benchmark does not hold`);
    assertRecordedAsDeclared(trial, task);
    trialsByTask.set(task.id, [...(trialsByTask.get(task.id) ?? []), trial]);
  }
  const tasks = benchmark.tasks.flatMap((task) => {
    const trials = trialsByTask.get(task.id);
    return trials === undefined ? [] : [rowOf(task, trials)];
  });
  return buildReliabilityReport({
    kind: 'benchmark',
    aggregate: aggregate(
      input.trials.map((trial) => trial.facts),
      { groupBy: input.groupBy },
    ),
    harness: {
      suite: { name: benchmark.name, digest: suiteDigestOf(benchmark) },
      answeredBy: uniqueAnswerers(input.answeredBy),
      unrecordedAnswers: input.unrecordedAnswers,
      codeDigest: input.codeDigest,
    },
    tasks,
  });
};
