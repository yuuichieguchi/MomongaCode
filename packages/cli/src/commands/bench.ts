import path from 'node:path';
import { runBenchmark, validateBenchmark } from '@momonga/eval';
import type { BenchProblem, BenchRunApi, TaskValidation } from '@momonga/eval';
import { codeDigestOfRunningProcess, createOwnedDirectory } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { MAIN_AGENT } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import { encodeReliabilityReport, formatReliabilityReport } from '@momonga/reliability';
import { DaemonMoved } from '../client/runtime-client.ts';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import { pinnedModelOf } from '../eval/context-host.ts';
import { shellModelsOf } from '../plain-http.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import { EvaluateUsageError } from './evaluate.ts';

export type EvaluateBenchOptions = { validate: boolean; model?: string; report?: string; interrupt: AbortSignal };

export const BENCHMARK_FILE = 'benchmark.json';

const WORKSPACE_PREFIX = 'momonga-bench-';

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

const validate = async (ports: Pick<CliPorts, 'stdout' | 'probe' | 'files' | 'tmpdir'>, benchmarkFile: string): Promise<number> => {
  const { name, tasks } = await validateBenchmark(benchmarkFile, { probe: ports.probe, files: ports.files, tmpdir: ports.tmpdir });
  for (const task of tasks) ports.stdout.write(validationLine(task));
  const wrong = tasks.filter((task) => task.problems.length > 0).length;
  if (wrong === 0) {
    ports.stdout.write(`The benchmark ${name} is valid: ${tasksText(tasks.length)}.\n`);
    return 0;
  }
  ports.stdout.write(`The benchmark ${name} is not valid: ${wrong} of ${tasksText(tasks.length)} ${wrong === 1 ? 'has' : 'have'} a problem.\n`);
  return 1;
};

type BenchClient = Pick<RuntimeClient, 'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'getSession' | 'runAnsweredBy' | 'resolveApproval' | 'cancel'>;

export const benchRunApi = (client: BenchClient, env: Readonly<Record<string, string>>): BenchRunApi => {
  async function* events(runId: string): AsyncGenerator<PublicRunEvent> {
    let cursor: number | undefined;
    for (;;) {
      try {
        for await (const frame of client.streamEvents(runId, cursor === undefined ? {} : { lastEventId: cursor })) {
          cursor = frame.id;
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
        costNano: run.usage.costNano ?? 0,
        origin: run.origin,
        agent: run.agent ?? MAIN_AGENT,
        mode: session.permissionMode,
        model: session.model,
        declared: run.report.declaration !== null && run.report.declaration.conditions.length > 0,
      };
    },
    answeredBy: async (runId) => (await client.runAnsweredBy(runId)).answeredBy,
    resolveApproval: async (approvalId, optionId) => void (await client.resolveApproval(approvalId, optionId)),
    cancelRun: async (runId) => void (await client.cancel(runId)),
  };
};

const run = async (ports: CliPorts, paths: MomongaPaths, benchmarkFile: string, options: { model: string; report?: string; interrupt: AbortSignal }): Promise<number> => {
  const model = pinnedModelOf(shellModelsOf(ports), options.model);
  await ensureCurrentDaemon(ports, paths);
  const env = await environmentSnapshot(ports);
  const client = connectRuntime(ports, paths);
  const scratch = await createOwnedDirectory({ parent: ports.tmpdir, prefix: WORKSPACE_PREFIX });
  try {
    const { report, invalidSetup } = await runBenchmark(benchmarkFile, {
      api: benchRunApi(client, env),
      probe: ports.probe,
      files: ports.files,
      model,
      codeDigest: await codeDigestOfRunningProcess(),
      groupBy: 'model',
      scratch: scratch.path,
      signal: options.interrupt,
    });
    if (options.report !== undefined) await ports.files.writeText(path.resolve(ports.cwd, options.report), encodeReliabilityReport(report));
    ports.stdout.write(formatReliabilityReport(report));
    for (const entry of invalidSetup) ports.stdout.write(`invalid_setup: task ${entry.taskId} trial ${entry.trial} (excluded: its setup did not exit 0)\n`);
    return 0;
  } finally {
    await scratch.dispose();
    await client.close();
  }
};

export const evaluateBench = async (ports: CliPorts, paths: MomongaPaths, directory: string, options: EvaluateBenchOptions): Promise<number> => {
  const benchmarkFile = path.join(path.resolve(ports.cwd, directory), BENCHMARK_FILE);
  if (options.validate) {
    if (options.model !== undefined || options.report !== undefined) throw new EvaluateUsageError('--validate runs no model and builds no report, so it takes neither --model nor --report');
    return validate(ports, benchmarkFile);
  }
  if (options.model === undefined) throw new EvaluateUsageError('--model <model> is required for a run of the benchmark: it names the model every task runs on');
  return run(ports, paths, benchmarkFile, { model: options.model, interrupt: options.interrupt, ...(options.report === undefined ? {} : { report: options.report }) });
};
