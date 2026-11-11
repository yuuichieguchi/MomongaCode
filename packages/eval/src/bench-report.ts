import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { AnsweredByView, RunCostView, RunFactsView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, costOf } from '@momonga/reliability';
import type { GroupKey, NotRun, ReliabilityReport, TaskLabels, TaskRow } from '@momonga/reliability';
import type { Benchmark, BenchTask } from './bench.ts';
import { uniqueAnswerers } from './context-report.ts';
import { EvalError } from './runner.ts';
import { completionAgreement } from './oracle.ts';
import type { GateVerdict } from './oracle.ts';

export type BenchmarkTrial = { taskId: string; trial: number; facts: RunFactsView; children: readonly RunFactsView[]; costs: readonly RunCostView[] };

export type BuildBenchmarkReportInput = {
  benchmark: Benchmark;
  trials: readonly BenchmarkTrial[];
  notRun: readonly NotRun[];
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

const gateVerdictOfFacts = (facts: RunFactsView): GateVerdict => {
  if (facts.status === 'STOPPED' && facts.stopReason === 'conditions_unmet') return 'failed';
  return facts.status === 'COMPLETED' && facts.verification.rounds > 0 ? 'passed' : 'not_run';
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
  const labels = new Map<string, TaskLabels>();
  for (const trial of input.trials) {
    const task = tasksById.get(trial.taskId);
    if (task === undefined) throw new EvalError(`trial ${trial.trial} (run ${trial.facts.runId}) names the task ${trial.taskId}, which the benchmark does not hold`);
    assertRecordedAsDeclared(trial, task);
    labels.set(trial.facts.rootRunId, { taskType: task.taskType, difficulty: task.difficulty });
    trialsByTask.set(task.id, [...(trialsByTask.get(task.id) ?? []), trial]);
  }
  const tasks = benchmark.tasks.flatMap((task) => {
    const trials = trialsByTask.get(task.id);
    return trials === undefined ? [] : [rowOf(task, trials)];
  });
  const aggregated = aggregate(
    input.trials.flatMap((trial) => [trial.facts, ...trial.children]),
    { groupBy: input.groupBy, labels },
  );
  return buildReliabilityReport({
    kind: 'benchmark',
    aggregate: aggregated,
    cost: costOf(aggregated, input.trials.flatMap((trial) => trial.costs)),
    notRun: [...input.notRun],
    harness: {
      suite: { name: benchmark.name, digest: suiteDigestOf(benchmark) },
      answeredBy: uniqueAnswerers(input.answeredBy),
      unrecordedAnswers: input.unrecordedAnswers,
      codeDigest: input.codeDigest,
    },
    tasks,
    gate: completionAgreement(input.trials.map((trial) => ({ gate: gateVerdictOfFacts(trial.facts), oracle: trial.facts.met }))),
  });
};
