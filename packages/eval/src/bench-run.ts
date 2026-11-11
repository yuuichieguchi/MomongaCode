import path from 'node:path';
import type { AnsweredByView, Mandate, PermissionMode, PublicRunEvent, RunFactsView, RunStatus, StopReason } from '@momonga/protocol';
import { FACTS_EVENT_TYPES, foldFacts } from '@momonga/reliability';
import type { FactsEvent, GroupKey, ReliabilityReport } from '@momonga/reliability';
import { BENCH_DEFAULT_RUNS, mandateOfTask, parseBenchmark, treeDigest } from './bench.ts';
import type { BenchTask, Benchmark } from './bench.ts';
import { gradeTrial } from './bench-grade.ts';
import type { WorkspaceFiles } from './files.ts';
import type { WorkspaceProbe } from './oracle-grade.ts';
import { buildBenchmarkReport } from './bench-report.ts';
import type { BenchmarkTrial } from './bench-report.ts';
import { failedWithCleanup } from './context-live.ts';
import { EvalError, driveRun } from './runner.ts';
import { answeredByOfRuns, treeSpendOf } from './run-tree.ts';

export type BenchRunView = {
  sessionId: string;
  status: RunStatus;
  stopReason?: StopReason;
  createdAt: number;
  deadlineAt: number;
  limits: { maxSteps?: number; maxTotalTokens?: number; maxCostNano?: number };
  step: number;
  tokensTotal: number;
  costNano: number;
  origin: string;
  agent: string;
  mode: PermissionMode;
  model: string;
  declared: boolean;
};

export type BenchRunApi = {
  createSession(input: { cwd: string; permissionMode: PermissionMode; model: string }): Promise<{ id: string }>;
  createRun(sessionId: string, input: { input: string; timeoutMs: number; limits: { maxSteps: number; maxTotalTokens: number }; mandate?: Mandate }): Promise<{ id: string }>;
  events(runId: string): AsyncIterable<PublicRunEvent>;
  runOf(runId: string): Promise<BenchRunView>;
  answeredBy(runId: string): Promise<AnsweredByView[]>;
  resolveApproval(approvalId: string, optionId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
};

export type BenchTrialHome = { cwd: string; api: BenchRunApi; close(): Promise<void> };

export type BenchRunPorts = {
  open(task: BenchTask, trial: number): Promise<BenchTrialHome>;
  probe: WorkspaceProbe;
  files: WorkspaceFiles;
  model: string;
  codeDigest: string;
  groupBy: GroupKey;
  onTrial?(trial: { taskId: string; trial: number; met: boolean | 'invalid_setup' }): void;
  signal?: AbortSignal;
};

export type InvalidSetup = { taskId: string; trial: number };

export type BenchRunResult = { report: ReliabilityReport; invalidSetup: InvalidSetup[] };

type FoldedType = Exclude<(typeof FACTS_EVENT_TYPES)[number], 'run.started'>;

type FoldedEvent = Extract<PublicRunEvent, { type: FoldedType }>;

const FOLDED_TYPES: ReadonlySet<string> = new Set(FACTS_EVENT_TYPES.filter((type) => type !== 'run.started'));

const isFolded = (event: PublicRunEvent): event is FoldedEvent => 'runId' in event && FOLDED_TYPES.has(event.type);

const factsEventsOf = (events: readonly PublicRunEvent[]): FactsEvent[] => events.filter(isFolded);

const setUp = async (task: BenchTask, workspace: string, probe: WorkspaceProbe, signal: AbortSignal | undefined): Promise<boolean> => {
  for (const step of task.setup) {
    signal?.throwIfAborted();
    const outcome = await probe.run(step.run, step.timeoutMs, workspace);
    if (outcome.timedOut || outcome.exitCode !== 0) return false;
  }
  return true;
};

type Trial = { facts: RunFactsView; children: RunFactsView[]; answeredBy: AnsweredByView[] };

const factsOfRun = async (api: BenchRunApi, runId: string, rootRunId: string, events: readonly PublicRunEvent[]): Promise<RunFactsView> => {
  const view = await api.runOf(runId);
  const folded = foldFacts(factsEventsOf(events), {
    runId,
    rootRunId,
    sessionId: view.sessionId,
    status: view.status,
    ...(view.stopReason === undefined ? {} : { stopReason: view.stopReason }),
    createdAt: view.createdAt,
    limits: view.limits,
    deadlineAt: view.deadlineAt,
    step: view.step,
    tokensTotal: view.tokensTotal,
    costNano: view.costNano,
    model: view.model,
    mode: view.mode,
    agent: view.agent,
    origin: view.origin,
  });
  return { ...folded, declared: view.declared };
};

const runTrial = async (task: BenchTask, repository: string, workspace: string, api: BenchRunApi, ports: BenchRunPorts): Promise<Trial> => {
  const session = await api.createSession({ cwd: workspace, permissionMode: task.permissionMode, model: ports.model });
  const mandate = mandateOfTask(task);
  const run = await api.createRun(session.id, {
    input: task.prompt,
    timeoutMs: task.budget.timeoutMs,
    limits: { maxSteps: task.budget.maxSteps, maxTotalTokens: task.budget.maxTotalTokens },
    ...(mandate === undefined ? {} : { mandate }),
  });
  const driven = await driveRun(api, task, run.id, ports.signal);
  ports.signal?.throwIfAborted();
  const folded = await factsOfRun(api, run.id, run.id, driven.events);
  const children: RunFactsView[] = [];
  for (const child of driven.children) children.push(await factsOfRun(api, child.runId, run.id, child.events));
  const grade = await gradeTrial({ task, workspace, base: repository, probe: ports.probe, files: ports.files });
  const answeredBy = await answeredByOfRuns((runId) => api.answeredBy(runId), [run.id, ...driven.children.map((child) => child.runId)]);
  return { facts: { ...folded, ...treeSpendOf([folded, ...children]), met: grade.met }, children, answeredBy };
};

const inHome = async <T>(home: BenchTrialHome, work: () => Promise<T>): Promise<T> => {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      await home.close();
    } catch (cleanup) {
      throw failedWithCleanup(error, cleanup, 'a trial failed and its temporary home was not released');
    }
    throw error;
  }
  await home.close();
  return result;
};

const verifiedRepositories = async (files: WorkspaceFiles, benchmark: Benchmark, root: string): Promise<Map<string, string>> => {
  const directories = new Map<string, string>();
  for (const task of benchmark.tasks) {
    if (directories.has(task.repository)) continue;
    const declared = benchmark.repositories[task.repository];
    if (declared === undefined) throw new EvalError(`task ${task.id} names the repository ${task.repository}, which the benchmark does not declare`);
    const directory = path.join(root, declared.directory);
    const digest = await treeDigest(files, directory);
    if (digest !== declared.digest) {
      throw new EvalError(`task ${task.id}: the repository ${task.repository} has the digest ${digest} and the benchmark file names ${declared.digest}, so its content is not the one the benchmark was written for`);
    }
    directories.set(task.repository, directory);
  }
  return directories;
};

export const runBenchmark = async (benchmarkFile: string, ports: BenchRunPorts): Promise<BenchRunResult> => {
  const benchmark = parseBenchmark(await ports.files.readTextFile(benchmarkFile), benchmarkFile);
  const repositories = await verifiedRepositories(ports.files, benchmark, path.dirname(path.resolve(benchmarkFile)));
  const trials: BenchmarkTrial[] = [];
  const invalidSetup: InvalidSetup[] = [];
  const answeredBy: AnsweredByView[] = [];
  let unrecordedAnswers = 0;
  for (const task of benchmark.tasks) {
    const repository = repositories.get(task.repository);
    if (repository === undefined) throw new EvalError(`task ${task.id} names the repository ${task.repository}, which was not verified`);
    for (let trial = 0; trial < (task.runs ?? BENCH_DEFAULT_RUNS); trial += 1) {
      ports.signal?.throwIfAborted();
      const home = await ports.open(task, trial);
      const outcome = await inHome(home, async () => {
        await ports.files.cp(repository, home.cwd);
        if (!(await setUp(task, home.cwd, ports.probe, ports.signal))) return undefined;
        ports.signal?.throwIfAborted();
        return runTrial(task, repository, home.cwd, home.api, ports);
      });
      if (outcome === undefined) {
        invalidSetup.push({ taskId: task.id, trial });
        ports.onTrial?.({ taskId: task.id, trial, met: 'invalid_setup' });
        continue;
      }
      trials.push({ taskId: task.id, trial, facts: outcome.facts, children: outcome.children });
      answeredBy.push(...outcome.answeredBy);
      if (outcome.answeredBy.length === 0) unrecordedAnswers += 1;
      ports.onTrial?.({ taskId: task.id, trial, met: outcome.facts.met });
    }
  }
  return {
    report: buildBenchmarkReport({ benchmark, trials, answeredBy, unrecordedAnswers, codeDigest: ports.codeDigest, groupBy: ports.groupBy }),
    invalidSetup,
  };
};
