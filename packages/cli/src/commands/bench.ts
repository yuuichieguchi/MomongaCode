import path from 'node:path';
import type { UserModels } from '@momonga/config';
import { caseSettingsFor, failedWithCleanup, refuseExistingOutput, runBenchmark, validateBenchmark } from '@momonga/eval';
import type { BenchProblem, BenchRunApi, BenchRunResult, TaskValidation, WorkspaceFiles, WorkspaceProbe } from '@momonga/eval';
import { EXIT_FAILURE, EXIT_OK, codeDigestOfRunningProcess, currentSocketResolver, resolveLayoutLocks } from '@momonga/foundation';
import type { KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import { MAIN_AGENT, isOpaqueEvent } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import { encodeReliabilityReport, formatReliabilityReport } from '@momonga/reliability';
import type { GroupKey } from '@momonga/reliability';
import { recordedCostsOf } from '../client/recorded-costs.ts';
import { DaemonMoved } from '../client/runtime-client.ts';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';
import { createHomes, liveSettingsFor, needsPlanRelay, pinnedModelOf, readCredentials, readPlanRelay, sweepStaleHomes, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import type { ContextRuntime, HomeEffects, Homes, ReflectionBounds } from '../eval/context-host.ts';
import { shellModelsOf } from '../plain-http.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { EvaluateUsageError } from './evaluate.ts';

export type EvaluateBenchOptions = { validate: boolean; model?: string; report?: string; groupBy: GroupKey; interrupt: AbortSignal };

export const BENCHMARK_FILE = 'benchmark.json';

const PROBLEM_TEXT: Record<BenchProblem, string> = {
  digest_mismatch: 'the content of the repository is not the one the benchmark file names',
  grader_file_in_repository: 'a grader file is already in the repository',
  setup_failed: 'the setup did not exit 0',
  already_passing: 'the oracle already passes on the initial repository',
  unsolvable: 'the oracle does not pass with the reference solution',
};

const tasksText = (count: number): string => `${count} ${count === 1 ? 'task' : 'tasks'}`;

const countText = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const validationLine = (task: TaskValidation): string => {
  const verdict = task.problems.length === 0 ? 'valid' : task.problems.map((problem) => PROBLEM_TEXT[problem]).join('; ');
  const { files, linesAdded, linesRemoved } = task.reference;
  return `Task ${task.id}: ${verdict}; labelled ${task.difficulty} by ${task.labelledBy} on ${task.labelledAt}; the reference changes ${countText(files, 'file', 'files')}, ${countText(linesAdded, 'line', 'lines')} added and ${linesRemoved} removed\n`;
};

const validate = async (ports: Pick<CliPorts, 'stdout' | 'probe' | 'files' | 'tmpdir'>, paths: MomongaPaths, benchmarkFile: string): Promise<number> => {
  const { name, tasks } = await validateBenchmark(benchmarkFile, { probe: ports.probe, files: ports.files, tmpdir: ports.tmpdir, lock: resolveLayoutLocks(paths).mechanism });
  for (const task of tasks) ports.stdout.write(validationLine(task));
  const wrong = tasks.filter((task) => task.problems.length > 0).length;
  if (wrong === 0) {
    ports.stdout.write(`The benchmark ${name} is valid: ${tasksText(tasks.length)}.\n`);
    return 0;
  }
  ports.stdout.write(`The benchmark ${name} is not valid: ${wrong} of ${tasksText(tasks.length)} ${wrong === 1 ? 'has' : 'have'} a problem.\n`);
  return 1;
};

type BenchClient = Pick<RuntimeClient, 'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'getSession' | 'runAnsweredBy' | 'reportCost' | 'resolveApproval' | 'cancel'>;

export const benchRunApi = (client: BenchClient, env: Readonly<Record<string, string>>): BenchRunApi => {
  async function* events(runId: string): AsyncGenerator<PublicRunEvent> {
    let cursor: number | undefined;
    for (;;) {
      try {
        for await (const frame of client.streamEvents(runId, cursor === undefined ? {} : { lastEventId: cursor })) {
          cursor = frame.id;
          if (isOpaqueEvent(frame.data)) continue;
          yield frame.data;
        }
        return;
      } catch (error) {
        if (!(error instanceof DaemonMoved)) throw error;
      }
    }
  }
  return {
    createSession: async (input) => ({ id: (await client.createSession({ cwd: input.cwd, env, permissionMode: input.permissionMode, model: input.model })).session.id }),
    createRun: async (sessionId, input) => ({
      id: (await client.createRun(sessionId, input.input, { timeoutMs: input.timeoutMs, limits: input.limits, ...(input.mandate === undefined ? {} : { mandate: input.mandate }) })).run.id,
    }),
    events,
    runOf: async (runId) => {
      const run = await client.getRun(runId);
      const session = await client.getSession(run.sessionId);
      if (run.report === undefined) throw new Error(`the runtime returned run ${run.id} without its report`);
      return {
        sessionId: run.sessionId,
        status: run.status,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        createdAt: run.createdAt,
        deadlineAt: run.deadlineAt,
        limits: {
          ...(run.limits.maxSteps === undefined ? {} : { maxSteps: run.limits.maxSteps }),
          ...(run.limits.maxTotalTokens === undefined ? {} : { maxTotalTokens: run.limits.maxTotalTokens }),
          ...(run.report.budget?.limits.maxCostNano === undefined ? {} : { maxCostNano: run.report.budget.limits.maxCostNano }),
        },
        step: run.step,
        tokensTotal: run.usage.totalTokens,
        origin: run.origin,
        agent: run.agent ?? MAIN_AGENT,
        mode: session.permissionMode,
        model: session.model,
        declared: run.report.declaration !== null && run.report.declaration.conditions.length > 0,
      };
    },
    answeredBy: async (runId) => (await client.runAnsweredBy(runId)).answeredBy,
    costs: (runIds) => recordedCostsOf(client, runIds),
    resolveApproval: async (approvalId, optionId) => void (await client.resolveApproval(approvalId, optionId)),
    cancelRun: async (runId) => void (await client.cancel(runId)),
  };
};

export type BenchRuntime = ContextRuntime & Pick<RuntimeClient, 'getSession'>;

export type BenchHostEffects = HomeEffects<BenchRuntime>;

export const nodeBenchEffects = (ports: CliPorts, lock: KernelLockMechanism): BenchHostEffects => ({ ...nodeContextEffects(ports, lock), connect: (paths) => connectRuntime(ports, paths) });

export type BenchLiveInput = {
  benchmarkFile: string;
  model: string;
  models: UserModels;
  probe: WorkspaceProbe;
  files: WorkspaceFiles;
  codeDigest: string;
  groupBy: GroupKey;
  reflection: ReflectionBounds;
  interrupt: AbortSignal;
  onUnreadableHomes?(count: number): void;
  onUnownedHomes?(roots: readonly string[]): void;
  planRelaySocket?(): Promise<string>;
};

const disposeAfter = async (homes: Homes<BenchRuntime>, error: unknown): Promise<void> => {
  try {
    await homes.dispose();
  } catch (cleanup) {
    throw failedWithCleanup(error, cleanup, 'the measurement failed and its temporary homes were not fully released');
  }
};

export const runBenchLive = async (effects: BenchHostEffects, input: BenchLiveInput): Promise<BenchRunResult> => {
  const { interrupt } = input;
  interrupt.throwIfAborted();
  const relay = needsPlanRelay(input.models, [input.model]) && input.planRelaySocket !== undefined ? await readPlanRelay(await input.planRelaySocket(), interrupt) : undefined;
  const settings = liveSettingsFor(input.models, [input.model], relay);
  const credentialValues = await readCredentials(effects, settings.credentials, interrupt);
  const swept = await sweepStaleHomes(effects);
  if (swept.unreadable > 0) input.onUnreadableHomes?.(swept.unreadable);
  if (swept.unowned.length > 0) input.onUnownedHomes?.(swept.unowned);
  const homes = createHomes(effects, { credentialValues, reflection: input.reflection, managedTargets: settings.managedTargets, endpointProbes: settings.endpointProbes, interrupt });
  const base = { models: settings.models, ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }) };
  let result: BenchRunResult;
  try {
    result = await runBenchmark(input.benchmarkFile, {
      open: async (task, trial) => {
        const home = await homes.open({ label: `task ${task.id} trial ${trial}`, settings: caseSettingsFor(base, {}) });
        return { cwd: home.cwd, api: benchRunApi(home.runtime, home.env), close: home.close };
      },
      probe: input.probe,
      files: input.files,
      model: input.model,
      codeDigest: input.codeDigest,
      groupBy: input.groupBy,
      signal: interrupt,
    });
  } catch (error) {
    await disposeAfter(homes, error);
    throw error;
  }
  await homes.dispose();
  return result;
};

const run = async (
  ports: CliPorts,
  paths: MomongaPaths,
  benchmarkFile: string,
  options: { model: string; report?: string; groupBy: GroupKey; interrupt: AbortSignal },
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => BenchHostEffects,
): Promise<number> => {
  const reportFile = options.report === undefined ? undefined : path.resolve(ports.cwd, options.report);
  if (reportFile !== undefined) await refuseExistingOutput(ports.files, reportFile);
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } = await import('@momonga/runtime');
  const models = await shellModelsOf(ports, options.interrupt);
  const { report, trialsRun } = await runBenchLive(hostEffects(ports, resolveLayoutLocks(paths).mechanism), {
    benchmarkFile,
    model: pinnedModelOf(models, options.model),
    models,
    probe: ports.probe,
    files: ports.files,
    codeDigest: await codeDigestOfRunningProcess(),
    groupBy: options.groupBy,
    reflection: { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS },
    planRelaySocket: currentSocketResolver(paths, 'gateway'),
    onUnreadableHomes: (count) => ports.stderr.write(unreadableHomesNotice(count)),
    onUnownedHomes: (roots) => ports.stderr.write(unownedHomesNotice(roots)),
    interrupt: options.interrupt,
  });
  ports.stdout.write(formatReliabilityReport(report));
  if (reportFile !== undefined) await ports.files.writeText(reportFile, encodeReliabilityReport(report));
  if (trialsRun > 0) return EXIT_OK;
  ports.stderr.write('no trial ran, so the report measures nothing\n');
  return EXIT_FAILURE;
};

export const evaluateBench = async (
  ports: CliPorts,
  paths: MomongaPaths,
  directory: string,
  options: EvaluateBenchOptions,
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => BenchHostEffects = nodeBenchEffects,
): Promise<number> => {
  const benchmarkFile = path.join(path.resolve(ports.cwd, directory), BENCHMARK_FILE);
  if (options.validate) {
    if (options.model !== undefined || options.report !== undefined) throw new EvaluateUsageError('--validate runs no model and builds no report, so it takes neither --model nor --report');
    return validate(ports, paths, benchmarkFile);
  }
  if (options.model === undefined) throw new EvaluateUsageError('--model <model> is required for a run of the benchmark: it names the model every task runs on');
  return run(ports, paths, benchmarkFile, { model: options.model, groupBy: options.groupBy, interrupt: options.interrupt, ...(options.report === undefined ? {} : { report: options.report }) }, hostEffects);
};
